const { app, BrowserWindow, contextBridge, webFrame } = require('electron')

if (process.type === 'renderer') {
  contextBridge.exposeInMainWorld('__orcaNativeZoom', {
    get: () => webFrame.getZoomLevel(),
    set: (level) => webFrame.setZoomLevel(level)
  })
} else {
  if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
    throw new Error('Native proof requires background launch')
  }
  if (process.platform === 'darwin') {
    app.setActivationPolicy('prohibited')
  }
  const option = (name) =>
    process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
  app.setPath('userData', option('--profile'))
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.whenReady().then(() => {
    const window = new BrowserWindow({
      width: 1200,
      height: 400,
      minHeight: 400,
      show: false,
      focusable: false,
      autoHideMenuBar: true,
      titleBarStyle:
        process.platform === 'darwin'
          ? 'hiddenInset'
          : process.platform === 'win32'
            ? 'hidden'
            : undefined,
      ...(process.platform === 'linux' ? { frame: false } : {}),
      webPreferences: {
        preload: __filename,
        contextIsolation: true,
        sandbox: false,
        backgroundThrottling: false
      }
    })
    void window.loadURL(option('--fixture-url'))
  })
  app.on('window-all-closed', () => app.quit())
}
