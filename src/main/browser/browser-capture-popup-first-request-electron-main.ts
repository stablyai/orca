export function browserCapturePopupFirstRequestElectronMain(): string {
  return String.raw`
const { app, BrowserWindow, BaseWindow, WebContentsView } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))

function settle(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function probe() {
  const captured = []
  const popupWindows = []
  const opener = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true }
  })
  opener.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { show: false },
    createWindow: (options) => {
      // Why: mirror Orca's openPopupWithOriginBar order exactly — adopt the
      // pre-created contents first, then attach the debugger synchronously in
      // the creation hook (prepareContent), before Chromium's first navigation.
      const popupWindow = new BaseWindow({ show: false, width: 800, height: 600 })
      const contentView = new WebContentsView({
        webContents: options.webContents,
        webPreferences: options.webPreferences
      })
      popupWindow.contentView.addChildView(contentView)
      popupWindows.push(popupWindow)
      const contents = contentView.webContents
      contents.debugger.attach('1.3')
      contents.debugger.on('message', (_event, method, params) => {
        if (method === 'Network.responseReceived') {
          captured.push({
            url: params.response.url,
            status: params.response.status,
            type: params.type
          })
        }
      })
      contents.debugger.sendCommand('Network.enable', {}).catch(() => {})
      return contents
    }
  }))
  await opener.loadURL(config.openerUrl)
  await settle(5000)
  opener.destroy()
  for (const popupWindow of popupWindows) {
    if (!popupWindow.isDestroyed()) {
      popupWindow.close()
    }
  }
  return { captured }
}

app.on('window-all-closed', () => {})

async function run() {
  const timeout = setTimeout(() => app.exit(2), 25000)
  await app.whenReady()
  const result = await probe()
  writeFileSync(config.resultPath, JSON.stringify(result))
  clearTimeout(timeout)
  app.quit()
}

run().catch((error) => {
  writeFileSync(config.resultPath, JSON.stringify({ error: String(error?.stack || error) }))
  app.exit(1)
})
`
}
