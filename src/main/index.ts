import { app, BrowserWindow, nativeImage, nativeTheme } from 'electron'
import { electronApp, is } from '@electron-toolkit/utils'
import devIcon from '../../resources/icon-dev.png?asset'
import { Store, initDataPath } from './persistence'
import { StatsCollector, initStatsPath } from './stats/collector'
import { ClaudeUsageStore, initClaudeUsagePath } from './claude-usage/store'
import { CodexUsageStore, initCodexUsagePath } from './codex-usage/store'
import { killAllPty } from './ipc/pty'
import { closeAllWatchers } from './ipc/filesystem-watcher'
import { registerCoreHandlers } from './ipc/register-core-handlers'
import { triggerStartupNotificationRegistration } from './ipc/notifications'
import { OrcaRuntimeService } from './runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime/runtime-rpc'
import { registerAppMenu } from './menu/register-app-menu'
import { checkForUpdatesFromMenu, isQuittingForUpdate } from './updater'
import {
  configureDevUserDataPath,
  enableMainProcessGpuFeatures,
  installDevParentDisconnectQuit,
  installDevParentWatchdog,
  installUncaughtPipeErrorGuard,
  patchPackagedProcessPath
} from './startup/configure-process'
import { attachMainWindowServices } from './window/attach-main-window-services'
import { createMainWindow } from './window/createMainWindow'

let mainWindow: BrowserWindow | null = null
let store: Store | null = null
let stats: StatsCollector | null = null
let claudeUsage: ClaudeUsageStore | null = null
let codexUsage: CodexUsageStore | null = null
let runtime: OrcaRuntimeService | null = null
let runtimeRpc: OrcaRuntimeRpcServer | null = null

installUncaughtPipeErrorGuard()
patchPackagedProcessPath()
configureDevUserDataPath(is.dev)
installDevParentDisconnectQuit(is.dev)
installDevParentWatchdog(is.dev)
// Why: must run after configureDevUserDataPath (which redirects userData to
// orca-dev in dev mode) but before app.setName('Orca') inside whenReady
// (which would change the resolved path on case-sensitive filesystems).
initDataPath()
// Why: same timing constraint as initDataPath — capture the userData path
// before app.setName changes it. See persistence.ts:20-28.
initStatsPath()
initClaudeUsagePath()
initCodexUsagePath()
enableMainProcessGpuFeatures()

function openMainWindow(): BrowserWindow {
  if (!store) {
    throw new Error('Store must be initialized before opening the main window')
  }
  if (!runtime) {
    throw new Error('Runtime must be initialized before opening the main window')
  }
  if (!stats) {
    throw new Error('Stats must be initialized before opening the main window')
  }
  if (!claudeUsage) {
    throw new Error('Claude usage store must be initialized before opening the main window')
  }
  if (!codexUsage) {
    throw new Error('Codex usage store must be initialized before opening the main window')
  }

  const window = createMainWindow(store)
  registerCoreHandlers(store, runtime, stats, claudeUsage, codexUsage, window.webContents.id)
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

  store = new Store()
  stats = new StatsCollector()
  claudeUsage = new ClaudeUsageStore(store)
  codexUsage = new CodexUsageStore(store)
  runtime = new OrcaRuntimeService(store, stats)
  nativeTheme.themeSource = store.getSettings().theme ?? 'system'

  registerAppMenu({
    onCheckForUpdates: () => checkForUpdatesFromMenu(),
    onOpenSettings: () => {
      mainWindow?.webContents.send('ui:openSettings')
    },
    onZoomIn: () => {
      mainWindow?.webContents.send('terminal:zoom', 'in')
    },
    onZoomOut: () => {
      mainWindow?.webContents.send('terminal:zoom', 'out')
    },
    onZoomReset: () => {
      mainWindow?.webContents.send('terminal:zoom', 'reset')
    }
  })
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
  const win = openMainWindow()

  // Why: the macOS notification permission dialog must fire after the window
  // is visible and focused. If it fires before the window exists, the system
  // dialog either doesn't appear or gets immediately covered by the maximized
  // window, making it impossible for the user to click "Allow".
  win.once('show', () => {
    triggerStartupNotificationRegistration(store!)
  })

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
  // Why: stats.flush() must run before killAllPty() so it can read the
  // live agent state and emit synthetic agent_stop events for agents that
  // are still running. killAllPty() does not call runtime.onPtyExit(),
  // so without this ordering, running agents would produce orphaned
  // agent_start events with no matching stops.
  stats?.flush()
  killAllPty()
  void closeAllWatchers()
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
