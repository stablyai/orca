import { app, BrowserWindow, ipcMain, session, webContents } from 'electron'
import { join } from 'node:path'
import { applyBackgroundActivationPolicy } from '../window/foreground-activation-policy'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Popup identity probes require a background launch')
}
applyBackgroundActivationPolicy()

const root = process.env.ORCA_POPUP_IDENTITY_ROOT
if (!root) {
  throw new Error('Missing probe root')
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1000,
    height: 700,
    webPreferences: {
      preload: join(root, 'preload.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })
  ipcMain.handle('browser:setGrabMode', () => undefined)
  ipcMain.handle('link-probe:open', (_event, event) =>
    window.webContents.send('browser:open-link-in-orca-tab', event)
  )
  ipcMain.handle('link-probe:register', (_event, args) => {
    const guest = webContents.fromId(args.webContentsId)
    return guest?.hostWebContents === window.webContents
  })
  ipcMain.handle('link-probe:guests', () =>
    webContents
      .getAllWebContents()
      .filter((guest) => guest.hostWebContents === window.webContents)
      .map((guest) => ({
        id: guest.id,
        url: guest.mainFrame.url,
        isolated: guest.session === session.fromPartition('persist:link-probe-isolated'),
        other: guest.session === session.fromPartition('persist:link-probe-default')
      }))
  )
  ipcMain.handle('link-probe:seed', async (_event, origin) => {
    await session
      .fromPartition('persist:link-probe-isolated')
      .cookies.set({ url: origin, name: 'synthetic_profile', value: 'isolated' })
    await session
      .fromPartition('persist:link-probe-default')
      .cookies.set({ url: origin, name: 'synthetic_profile', value: 'other' })
  })
  window.webContents.on('will-attach-webview', (_event, preferences) => {
    preferences.nodeIntegration = false
    preferences.contextIsolation = true
    preferences.sandbox = true
  })
  await window.loadFile(join(root, 'index.html'))
})
setTimeout(() => app.exit(1), 120_000).unref()
