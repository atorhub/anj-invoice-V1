/* script.js - ANJ Invoice V3 (BlackGold Pro)
   - PDF.js, Tesseract, html2canvas/jsPDF, Chart.js
   - Improved AI-like extractor + IndexedDB history + analytics
*/

/* ========== Basic DOM helpers ========== */
const $ = (id) => document.getElementById(id);
const hide = (id) => { const e = typeof id==='string'?$(id):id; e && e.classList.add('hidden'); }
const show = (id) => { const e = typeof id==='string'?$(id):id; e && e.classList.remove('hidden'); }
const fmt = (n) => (typeof n==='number' ? n.toLocaleString('en-IN',{minimumFractionDigits:2, maximumFractionDigits:2}) : n);

/* ========== IndexedDB (records store) ========== */
const DB_NAME = 'anj_invoice_v3';
const STORE = 'invoices_v3';
function openDB(){
  return new Promise((res,reject)=>{
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = (e)=> {
      const db = e.target.result;
      if(!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath:'id', autoIncrement:true });
    };
    rq.onsuccess = (e)=> res(e.target.result);
    rq.onerror = (e)=> reject(e.target.error);
  });
}
async function saveRecord(rec){
  const db = await openDB();
  return new Promise((res,reject)=>{
    const tx = db.transaction(STORE,'readwrite');
    const s = tx.objectStore(STORE);
    const r = s.add(rec);
    r.onsuccess = (ev)=> res(ev.target.result);
    r.onerror = (ev)=> reject(ev.target.error);
  });
}
async function getAllRecords(){
  const db = await openDB();
  return new Promise((res,reject)=>{
    const tx = db.transaction(STORE,'readonly');
    const s = tx.objectStore(STORE);
    const req = s.getAll();
    req.onsuccess = (e)=> res(e.target.result);
    req.onerror = (e)=> reject(e.target.error);
  });
}
async function deleteRecord(id){
  const db = await openDB();
  return new Promise((res,reject)=>{
    const tx = db.transaction(STORE,'readwrite');
    const s = tx.objectStore(STORE);
    const req = s.delete(id);
    req.onsuccess = ()=> res(true);
    req.onerror = (e)=> reject(e.target.error);
  });
}
async function clearAll(){
  const db = await openDB();
  return new Promise((res,reject)=>{
    const tx = db.transaction(STORE,'readwrite');
    const s = tx.objectStore(STORE);
    const req = s.clear();
    req.onsuccess = ()=> res(true);
    req.onerror = (e)=> reject(e.target.error);
  });
}

/* ========== Text extraction (PDF / IMG / TXT) ========== */
async function extractPDF(file){
  try{
    const arr = await file.arrayBuffer();
    const loading = pdfjsLib.getDocument(new Uint8Array(arr));
    const pdf = await loading.promise;
    let out = '';
    for(let i=1;i<=pdf.numPages;i++){
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(it=>it.str).join(' ');
      out += '\n' + pageText + '\n';
    }
    return out;
  }catch(e){
    console.error('PDF extraction error', e);
    throw e;
  }
}

async function extractImage(file){
  try{
    const worker = Tesseract.createWorker({ logger: m => { /* optional progress */ }});
    await worker.load();
    await worker.loadLanguage('eng');
    await worker.initialize('eng');
    const { data:{ text } } = await worker.recognize(file);
    await worker.terminate();
    return text;
  }catch(e){
    console.error('OCR error', e);
    throw e;
  }
}

/* ========== High-quality extractor functions ========== */

// Normalize lines: split and trim, remove many duplicate spaces
function normalizeLines(raw){
  const lines = raw.split(/\r?\n/).map(l=> l.replace(/\u00A0/g,' ').trim()).filter(Boolean);
  return lines.map(l => l.replace(/\s{2,}/g,' ').trim());
}

// Detect merchant: choose first UPPERCASE-ish line longer than 3 chars, or a clear brand match
function detectMerchant(lines){
  for(const l of lines.slice(0,6)){
    if(l.length>3 && /[A-Z]/.test(l) && !/GST|INVOICE|TAX|DATE|PHONE|MOB|ADDRESS/i.test(l)){
      // if many upper-case letters, likely merchant name
      const ratioUpper = (l.replace(/[^A-Z]/g,'').length / Math.max(1,l.length));
      if(ratioUpper > 0.2 || /^[A-Z0-9 ]+$/.test(l)) return l;
    }
  }
  // fallback brand keywords
  const brandMatch = rawSearch(lines.join(' '), ['megamart','mart','supermarket','hyperstore','store','shop','bazaar','pharmacy','d-mart','dmart','reliance','bigbazaar']);
  return brandMatch || lines[0] || 'Unknown Merchant';
}

// helper search for keywords -> return matched word
function rawSearch(txt, arr){
  const t = txt.toLowerCase();
  for(const k of arr) if(t.includes(k)) return k.toUpperCase();
  return null;
}

// Date detection: multiple formats
function detectDate(text){
  const candidates = [];
  // dd-MMM-yyyy or dd-MMM-yy
  const r1 = text.match(/\b([0-3]?\d[-\/\s](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-\/\s]\d{2,4})\b/i);
  if(r1) candidates.push(r1[1]);
  // dd/mm/yyyy
  const r2 = text.match(/\b([0-3]?\d[\/\-][0-1]?\d[\/\-]\d{2,4})\b/);
  if(r2) candidates.push(r2[1]);
  // yyyy-mm-dd
  const r3 = text.match(/\b(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})\b/);
  if(r3) candidates.push(r3[1]);
  // fallback: month name + year
  const r4 = text.match(/\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})\b/i);
  if(r4) candidates.push(r4[1]);
  return candidates[0] || '';
}

// Totals detection: subtotal, tax lines, grand total (₹)
function detectTotals(lines){
  const totals = { subtotal: 0, tax: 0, gst:{}, grand: 0, raw: [] };
  const rupeeRegex = /₹\s?([\d,]+(?:\.\d{1,2})?)/g;
  for(const l of lines){
    if(/\bsubtotal\b/i.test(l)){
      const m = l.match(/₹\s?([\d,]+(?:\.\d{1,2})?)/);
      if(m) totals.subtotal = toNumber(m[1]);
    }
    if(/grand\s*total/i.test(l) || /\btotal\s*amount\b/i.test(l) || /^total[:\s]/i.test(l)){
      const m = l.match(/₹\s?([\d,]+(?:\.\d{1,2})?)/);
      if(m) totals.grand = toNumber(m[1]);
    }
    if(/\b(GST|CGST|SGST|VAT|TAX)\b/i.test(l)){
      // capture percent and amount
      const m = l.match(/(CGST|SGST|GST|VAT)[^\d%]*(\d{1,2})%?.*₹\s?([\d,]+(?:\.\d{1,2})?)/i);
      if(m){
        const key = (m[1] || 'GST').toUpperCase();
        totals.gst[key] = (totals.gst[key]||0) + toNumber(m[3]);
        totals.tax += toNumber(m[3]);
      } else {
        // fallback single rupee detection
        const mm = [...l.matchAll(rupeeRegex)];
        if(mm.length) { totals.tax += toNumber(mm[mm.length-1][1]); }
      }
    }
    // collect rupee matches
    const mm = [...l.matchAll(rupeeRegex)].map(x=>x[1]);
    if(mm.length) totals.raw.push(...mm.map(toNumber));
  }
  // fallback compute grand from last rupee if missing
  if(!totals.grand && totals.raw.length) totals.grand = totals.raw[totals.raw.length-1];
  if(!totals.subtotal && totals.raw.length>1) totals.subtotal = totals.raw[totals.raw.length-2];
  return totals;
}

// Convert "1,234.00" -> number
function toNumber(s){ if(s==null) return 0; return Number(String(s).replace(/,/g,'')) || 0; }

/* ========== Item/table parser ========== */
// Primary regex for a line like:
// Product Name  <lots spaces>  QTY  <spaces>  Price  <spaces>  Total
const ITEM_LINE_RE = /^(.+?)\s+(\d+)\s+([\d,]+\.\d{1,2})\s+([\d,]+\.\d{1,2})$/;

/* Support alternate patterns, e.g.
 "Wireless Keyboard    2    1,299.00    2,598.00"
 "USB-C Cable 3 299 897"
*/
function extractItems(lines){
  const items = [];
  // First pass: exact item line regex
  for(const l of lines){
    const m = l.match(ITEM_LINE_RE);
    if(m){
      items.push({
        description: m[1].trim(),
        qty: Number(m[2]),
        unit: toNumber(m[3]),
        total: toNumber(m[4])
      });
    }
  }
  if(items.length) return items;

  // Second pass: lines containing rupee amounts; attempt heuristics
  for(const l of lines){
    // skip header/footer lines
    if(/\b(total|subtotal|grand|gst|tax|balance|change|payment|invoice|receipt|thank you|visit again)\b/i.test(l)) continue;

    // find last rupee amount in line
    const rupees = [...l.matchAll(/₹\s?([\d,]+(?:\.\d{1,2})?)/g)].map(m=>m[1]);
    if(rupees.length){
      const last = rupees[rupees.length-1];
      let total = toNumber(last);
      // qty heuristic: small integer earlier in the line
      const qtyMatch = l.match(/\b(\d{1,2})\b(?!.*\d{2,})/); // small integer
      let qty = qtyMatch ? Number(qtyMatch[1]) : 1;
      // description: take substring before first currency or before qty
      let desc = l.split(/₹/)[0].replace(/\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\b/g,'').trim();
      // rate fallback: if qty > 1, compute
      let unit = qty>0 ? +(total/qty).toFixed(2) : total;
      if(desc.length < 1) desc = 'Item';
      items.push({ description: desc, qty, unit, total });
    }
  }

  // Final fallback: detect pattern "Name - Price" etc
  if(!items.length){
    for(const l of lines){
      const m = l.match(/(.+?)\s+₹\s?([\d,]+(?:\.\d{1,2})?)/);
      if(m){
        items.push({ description: m[1].trim(), qty:1, unit: toNumber(m[2]), total: toNumber(m[2]) });
      }
    }
  }
  return items;
}

/* ========== Master parse function ========== */
async function parseRawText(rawText){
  const lines = normalizeLines(rawText);
  const joined = lines.join('\n');

  const merchant = detectMerchant(lines);
  const date = detectDate(joined);
  const totals = detectTotals(lines);
  const items = extractItems(lines);

  // Payment mode & ref detection
  const pm = joined.match(/\b(Payment Mode|Mode of Payment)[:\s]*([A-Za-z0-9]+)/i);
  const paymentMode = pm ? pm[2] : (joined.match(/\b(UPI|CARD|CASH|NETBANKING|PAYTM)\b/i)||[])[0] || '';
  const ref = (joined.match(/Ref(?:erence)?(?: ID| No|:)?\s*[:\-]?\s*([A-Za-z0-9@-]+)/i)||[])[1] || (joined.match(/\b[A-Z0-9]{6,}@[a-zA-Z]+/i)||[])[0] || '';

  // Invoice number
  const inv = (joined.match(/\b(?:Invoice|Inv|Bill|Receipt)[\s:]*([A-Za-z0-9\/\-]+)/i)||[])[1] || '';

  // Auto-category by keywords
  const category = autoCategorize(joined);

  return { merchant, date, items, totals, paymentMode, ref, invoiceNo: inv, category, raw: rawText };
}

/* ========== Categorizer (keyword mapping) ========== */
function autoCategorize(text){
  const t = text.toLowerCase();
  if(/grocery|mart|bread|vegetable|vegetables|fruits|dmart|bigbazaar|megamart|supermarket/.test(t)) return 'Groceries';
  if(/hotel|restaurant|dine|cafe|coffee|pizza|burger/.test(t)) return 'Dining';
  if(/pharm|medical|chemist|tablet|medicine/.test(t)) return 'Health';
  if(/fuel|petrol|diesel|petrol pump|fuel pump/.test(t)) return 'Fuel';
  if(/electronics|mobile|charger|headphone|speaker/.test(t)) return 'Electronics';
  return 'General';
}

/* ========== UI handlers ========== */
let currentRecord = null;

$('parseBtn').addEventListener('click', async ()=>{
  const f = $('fileInput').files[0];
  if(!f) return alert('Choose a file first.');
  // extract text
  try{
    let text = '';
    if(/pdf/i.test(f.type) || /\.pdf$/i.test(f.name)) text = await extractPDF(f);
    else if(f.type.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(f.name)) text = await extractImage(f);
    else text = await f.text();

    const parsed = await parseRawText(text);
    parsed.originalFileName = f.name;
    // attach blob buffer (store ArrayBuffer later)
    parsed.fileBlob = f;
    currentRecord = parsed;
    renderParsed(parsed);
  }catch(e){
    console.error(e);
    alert('Error parsing file: '+ (e.message||e));
  }
});

$('ocrBtn').addEventListener('click', async ()=>{
  const f = $('fileInput').files[0];
  if(!f) return alert('Choose a file first.');
  if(!f.type.startsWith('image/')) return alert('OCR works only for images; for PDF use Parse Bill.');
  try{
    const text = await extractImage(f);
    const parsed = await parseRawText(text);
    parsed.originalFileName = f.name;
    parsed.fileBlob = f;
    currentRecord = parsed;
    renderParsed(parsed);
  }catch(e){ console.error(e); alert('OCR error'); }
});

function renderParsed(p){
  // meta
  const metaHtml = `
    <div><strong>Merchant:</strong> ${escapeHtml(p.merchant)}</div>
    <div><strong>Invoice:</strong> ${escapeHtml(p.invoiceNo || '')} &nbsp; <strong>Date:</strong> ${escapeHtml(p.date || '')}</div>
    <div><strong>Payment:</strong> ${escapeHtml(p.paymentMode || '')} ${p.ref?(' • Ref: '+escapeHtml(p.ref)) : ''}</div>
    <div><strong>Category:</strong> ${escapeHtml(p.category || '')}</div>
    <div class="small muted">Detected totals — Subtotal: ₹${fmt(p.totals.subtotal)}, Tax: ₹${fmt(p.totals.tax)}, Grand: ₹${fmt(p.totals.grand)}</div>
  `;
  $('metaBlock').innerHTML = metaHtml;

  // items table
  let itemsHtml = '<table class="itemsTable"><thead><tr><th>#</th><th>Description</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead><tbody>';
  p.items.forEach((it,i)=>{
    itemsHtml += `<tr><td>${i+1}</td><td>${escapeHtml(it.description)}</td><td>${it.qty}</td><td>₹${fmt(it.unit)}</td><td>₹${fmt(it.total)}</td></tr>`;
  });
  itemsHtml += '</tbody></table>';
  $('itemsBlock').innerHTML = itemsHtml;

  show('parsedCard'); show('generateBtn');
  hide('invoiceCard');
}

/* ========== Save to history ========== */
$('saveBtn').addEventListener('click', async ()=>{
  if(!currentRecord) return alert('Nothing parsed to save.');
  const rec = {
    merchant: currentRecord.merchant,
    invoiceNo: currentRecord.invoiceNo,
    date: currentRecord.date,
    paymentMode: currentRecord.paymentMode,
    ref: currentRecord.ref,
    category: currentRecord.category,
    totals: currentRecord.totals,
    items: currentRecord.items,
    parsedAt: Date.now(),
    fileName: currentRecord.originalFileName || 'uploaded'
  };
  // attach file as ArrayBuffer if present
  if(currentRecord.fileBlob){
    try{
      const ab = await currentRecord.fileBlob.arrayBuffer();
      rec.fileBuffer = ab;
      rec.fileType = currentRecord.fileBlob.type || '';
    }catch(e){ console.warn('could not store file blob', e); }
  }
  const id = await saveRecord(rec);
  alert('Saved to history (id: '+id+')');
  await loadHistory();
});

/* ========== Load / Render history ========== */
async function loadHistory(){
  const all = await getAllRecords();
  const container = $('historyList');
  container.innerHTML = '';
  if(!all.length){ container.innerHTML = '<div class="muted">No saved bills yet.</div>'; return; }
  all.sort((a,b)=> b.parsedAt - a.parsedAt);
  for(const r of all){
    const div = document.createElement('div');
    div.className = 'historyItem';
    div.innerHTML = `
      <div class="h-left">
        <div style="width:48px;height:40px;border-radius:8px;background:linear-gradient(135deg,#2a2a2a,#111);display:flex;align-items:center;justify-content:center;">
          <strong style="color:${r.generated?'#ffd973':'#c9b68a'}">${(r.merchant||'ANJ').slice(0,2).toUpperCase()}</strong>
        </div>
        <div>
          <div style="font-weight:700">${escapeHtml(r.merchant || 'Unknown')}</div>
          <div class="h-meta">${escapeHtml(r.fileName || '')} • ${new Date(r.parsedAt).toLocaleString()}</div>
        </div>
      </div>
      <div class="h-actions">
        <button class="btn small ghost" onclick="viewRecord(${r.id})">View</button>
        <button class="btn small ghost" onclick="exportRecord(${r.id})">Export</button>
        <button class="btn small ghost" onclick="deleteRecordConfirm(${r.id})">Delete</button>
      </div>
    `;
    container.appendChild(div);
  }
  buildAnalytics(all);
}

/* view record */
async function viewRecord(id){
  const all = await getAllRecords();
  const rec = all.find(x=>x.id===id);
  if(!rec) return alert('Not found');
  // set as current
  currentRecord = rec;
  renderParsed(rec);
  // show invoice if previously generated html exists
  if(rec.generatedHtml){
    $('invoiceArea').innerHTML = rec.generatedHtml;
    show('invoiceCard');
  } else hide('invoiceCard');
  window.scrollTo({ top:0, behavior:'smooth' });
}

/* delete confirm */
async function deleteRecordConfirm(id){
  if(!confirm('Delete saved record?')) return;
  await deleteRecord(id);
  await loadHistory();
}

/* export one record as JSON */
async function exportRecord(id){
  const all = await getAllRecords();
  const rec = all.find(x=>x.id===id);
  if(!rec) return alert('Not found');
  const blob = new Blob([JSON.stringify(rec, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `anj-invoice-${id}.json`; a.click();
  URL.revokeObjectURL(url);
}

/* export all */
$('exportAllBtn').addEventListener('click', async ()=>{
  const all = await getAllRecords();
  const blob = new Blob([JSON.stringify(all, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `anj-invoice-history.json`; a.click();
  URL.revokeObjectURL(url);
});

/* clear all */
$('clearAllBtn').addEventListener('click', async ()=>{
  if(!confirm('Clear all history?')) return;
  await clearAll();
  await loadHistory();
});

/* ========== Invoice generation (HTML) ========== */
$('generateBtn').addEventListener('click', ()=>{
  if(!currentRecord) return alert('Nothing parsed to generate.');
  const html = buildInvoiceHtml(currentRecord);
  $('invoiceArea').innerHTML = html;
  // attach generated html to record (in-memory)
  currentRecord.generatedHtml = html;
  show('invoiceCard');
});

function buildInvoiceHtml(data){
  const items = data.items || [];
  const subtotal = items.reduce((s,it)=> s + (it.total || it.qty*(it.unit||it.rate||0)), 0);
  const tax = data.totals?.tax || +(subtotal*0.05).toFixed(2);
  const grand = data.totals?.grand || +(subtotal + tax).toFixed(2);

  const rows = items.map((it,i)=>`
    <tr>
      <td style="width:6%">${i+1}</td>
      <td>${escapeHtml(it.description)}</td>
      <td style="width:8%;text-align:center">${it.qty}</td>
      <td style="width:14%;text-align:right">₹${fmt(it.unit||it.rate||0)}</td>
      <td style="width:14%;text-align:right">₹${fmt(it.total|| (it.qty*(it.unit||it.rate||0)))}</td>
    </tr>
  `).join('');

  return `
    <div class="invoiceAreaInner" style="padding:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-weight:900;color:${'#ffd973'};font-size:20px">${escapeHtml(data.merchant||'ANJ BUSINESS INVOICE')}</div>
          <div style="font-size:12px;color:${'#c6b88a'}">${escapeHtml(data.fileName||'')}</div>
        </div>
        <div style="text-align:right;color:${'#c6b88a'}">
          <div><strong>Invoice:</strong> ${escapeHtml(data.invoiceNo||'INV-0001')}</div>
          <div><strong>Date:</strong> ${escapeHtml(data.date|| (new Date()).toLocaleDateString())}</div>
        </div>
      </div>

      <div style="margin-top:14px;overflow:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="text-align:left;color:${'#c8b88f'}">
              <th>#</th><th>Description</th><th>Qty</th><th style="text-align:right">Unit</th><th style="text-align:right">Total</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>

      <div style="display:flex;justify-content:flex-end;margin-top:12px">
        <div style="width:320px;background:linear-gradient(180deg, rgba(255,255,255,0.01), rgba(0,0,0,0.04));padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,0.02)">
          <div style="display:flex;justify-content:space-between;color:${'#c8b88f'}"><div>Subtotal</div><div>₹${fmt(subtotal)}</div></div>
          <div style="display:flex;justify-content:space-between;color:${'#c8b88f'}"><div>Tax</div><div>₹${fmt(tax)}</div></div>
          <div style="display:flex;justify-content:space-between;margin-top:8px;font-weight:900;color:${'#ffd973'}"><div>Grand Total</div><div>₹${fmt(grand)}</div></div>
        </div>
      </div>

      <div style="margin-top:14px;color:${'#bdb3a2'};font-size:12px">Thank you for your business. Generated by ANJ Invoice V3.</div>
    </div>
  `;
}

/* ========== 
