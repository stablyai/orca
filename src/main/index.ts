import { app, BrowserWindow, nativeImage, nativeTheme } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import devIcon from '../../resources/icon-dev.png?asset'
import { Store } from './persistence'
import { killAllPty } from './ipc/pty'
import { registerCoreHandlers } from './ipc/register-core-handlers'
import { OrcaRuntimeService } from './runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime/runtime-rpc'
import { registerAppMenu } from './menu/register-app-menu'
import { checkForUpdatesFromMenu, isQuittingForUpdate } from './updater'
import {
  configureDevUserDataPath,
  enableMainProcessGpuFeatures,
  installUncaughtPipeErrorGuard,
  patchPackagedProcessPath
} from './startup/configure-process'
import { attachMainWindowServices } from './window/attach-main-window-services'
import { createMainWindow } from './window/createMainWindow'

let mainWindow: BrowserWindow | null = null
let store: Store | null = null
let runtime: OrcaRuntimeService | null = null
let runtimeRpc: OrcaRuntimeRpcServer | null = null

installUncaughtPipeErrorGuard()
patchPackagedProcessPath()
configureDevUserDataPath(is.dev)
enableMainProcessGpuFeatures()

function openMainWindow(): BrowserWindow {
  if (!store) {
    throw new Error('Store must be initialized before opening the main window')
  }
  if (!runtime) {
    throw new Error('Runtime must be initialized before opening the main window')
  }

  const window = createMainWindow(store)
  attachMainWindowServices(window, store, runtime)
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
  })
  mainWindow = window
  return window
}

app.whenReady().then(async () => {
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
  runtime = new OrcaRuntimeService(store)
  nativeTheme.themeSource = store.getSettings().theme ?? 'system'

  registerAppMenu({
    onCheckForUpdates: () => checkForUpdatesFromMenu(),
    onOpenSettings: () => {
      mainWindow?.webContents.send('ui:openSettings')
    }
  })
  registerCoreHandlers(store, runtime)
  runtimeRpc = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: app.getPath('userData')
  })
  try {
    await runtimeRpc.start()
  } catch (error) {
    // Why: the local RPC transport enables the future CLI, but Orca should
    // still boot as an editor if the socket cannot be opened on this launch.
    console.error('[runtime] Failed to start local RPC transport:', error)
  }
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
  if (runtimeRpc) {
    void runtimeRpc.stop().catch((error) => {
      console.error('[runtime] Failed to stop local RPC transport:', error)
    })
  }
  store?.flush()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
