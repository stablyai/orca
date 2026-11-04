// Disposable native-provider fixture, launched only on an isolated desktop.
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const dir = process.env.BENCH_STATE_DIR
const instance = process.env.BENCH_INSTANCE
process.on('uncaughtException', (error) => {
  console.error(error)
  app.exit(1)
})
if (process.env.ORCA_COMPUTER_BENCH_ISOLATED !== '1') {
  process.exit(1)
}
app.whenReady().then(() => {
  const w = new BrowserWindow({
    x: 60,
    y: 60,
    width: 760,
    height: 560,
    title: 'BenchElectron',
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
  })
  const nativeWindowId =
    process.platform === 'linux' ? w.getNativeWindowHandle().readUInt32LE() : null
  ipcMain.on('st', (_event, state) => {
    const data = JSON.stringify({
      ...state,
      instance,
      activeForm: w.isFocused(),
      pid: process.pid,
      nativeWindowId
    })
    try {
      fs.writeFileSync(path.join(dir, 'state.json.tmp'), data)
      fs.renameSync(path.join(dir, 'state.json.tmp'), path.join(dir, 'state.json'))
    } catch (error) {
      // Windows readers can briefly deny replacement; the next state tick retries.
      if (!['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) {
        throw error
      }
    }
  })
  w.loadURL(
    `data:text/html,${encodeURIComponent(`<html><head><title>BenchElectron</title></head>
  <body style="font:14px sans-serif;height:4000px">
  <input id=field aria-label="field"><input id=decoy aria-label="decoy">
  <button id=button>Increment</button>
  <select id=color aria-label="Color"><option>Red</option><option>Green</option><option>Blue</option></select>
  <script>
  const { ipcRenderer } = require('electron');
  const field = document.getElementById('field'), decoy = document.getElementById('decoy');
  const color = document.getElementById('color');
  let count = 0, returns = 0, ack = null, seq = 0, submittedText = null, clickedColor = null;
  document.getElementById('button').onclick = () => { count++; clickedColor = color.value };
  field.addEventListener('keydown', event => {
    if (event.key === 'Enter') { returns++; submittedText = field.value }
  });
  function report() {
    ipcRenderer.send('st', { count, returns, submittedText, clickedColor, ack, seq: ++seq, text: field.value, decoyText: decoy.value,
      top: window.scrollY, combo: color.value, selStart: field.selectionStart,
      selLen: field.selectionEnd - field.selectionStart, check: false, menuHits: 0, dropOpen: false,
      logicalFocus: document.activeElement === field ? 'field' : document.activeElement === decoy ? 'decoy' : 'other' });
  }
  ipcRenderer.on('cmd', (_event, cmd) => {
    count = returns = 0;
    submittedText = clickedColor = null;
    field.value = cmd.task === 'replace_submit' ? 'hello' : '';
    field.setSelectionRange(field.value.length, field.value.length);
    decoy.value = 'untouched'; decoy.setSelectionRange(9, 9);
    color.selectedIndex = 0; color.blur(); window.scrollTo(0, 0);
    (cmd.task === 'targeted_type' ? decoy : field).focus();
    ack = cmd.nonce;
    report();
  });
  setInterval(report, 30);
  </script></body></html>`)}`
  )
  if (process.env.BENCH_FOCUS_SIBLING === '1') {
    const sibling = new BrowserWindow({
      x: 400,
      y: 300,
      width: 300,
      height: 200,
      title: 'BenchSibling'
    })
    sibling.loadURL('data:text/html,<title>BenchSibling</title><input aria-label="sibling">')
    w.on('closed', () => sibling.close())
  }
  setInterval(() => {
    const cmdPath = path.join(dir, 'cmd')
    if (!fs.existsSync(cmdPath)) {
      return
    }
    const raw = fs.readFileSync(cmdPath, 'utf8').trim()
    if (raw) {
      const cmd = JSON.parse(raw)
      fs.unlinkSync(cmdPath)
      if (cmd.instance === instance) {
        w.webContents.send('cmd', cmd)
      }
    }
  }, 30)
})
