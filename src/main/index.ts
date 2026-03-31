import { app, BrowserWindow, nativeImage, nativeTheme } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import devIcon from '../../resources/icon-dev.png?asset'
import { Store } from './persistence'
import { killAllPty } from './ipc/pty'
import { registerCoreHandlers } from './ipc/register-core-handlers'
import { registerAppMenu } from './menu/register-app-menu'
import { checkForUpdatesFromMenu, isQuittingForUpdate } from './updater'
import {
  enableMainProcessGpuFeatures,
  installUncaughtPipeErrorGuard,
  patchPackagedProcessPath
} from './startup/configure-process'
import { attachMainWindowServices } from './window/attach-main-window-services'
import { createMainWindow } from './window/createMainWindow'

let mainWindow: BrowserWindow | null = null
let store: Store | null = null

installUncaughtPipeErrorGuard()
patchPackagedProcessPath()
enableMainProcessGpuFeatures()

function openMainWindow(): BrowserWindow {
  if (!store) {
    throw new Error('Store must be initialized before opening the main window')
  }

  const window = createMainWindow(store)
  attachMainWindowServices(window, store)
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
  })
  mainWindow = window
  return window
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.stablyai.orca')
  app.setName('Orca')

  if (process.platform === 'darwin' && is.dev) {
    const dockIcon = nativeImage.createFromPath(devIcon)
    app.dock?.setIcon(dockIcon)
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  store = new Store()
  nativeTheme.themeSource = store.getSettings().theme ?? 'system'

  registerAppMenu({
    onCheckForUpdates: () => checkForUpdatesFromMenu(),
    onOpenSettings: () => {
      mainWindow?.webContents.send('ui:openSettings')
    }
  })
  registerCoreHandlers(store)
  openMainWindow()

  app.on('activate', () => {
    // Don't re-open a window while Squirrel's ShipIt is replacing the .app
    // bundle.  Without this guard the old version gets resurrected and the
    // update never applies.
    if (BrowserWindow.getAllWindows().length === 0 && !isQuittingForUpdate()) {
      openMainWindow()
    }
  })
})

app.on('before-quit', () => {
  killAllPty()
  store?.flush()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
