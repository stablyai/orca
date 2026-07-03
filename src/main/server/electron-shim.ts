/**
 * Build-time alias target for `electron` in the headless server bundle.
 *
 * Two tiers:
 *  - BENIGN no-ops for APIs whose headless behavior is simply "do nothing":
 *    `ipcMain` (the renderer bridge — a headless server has no renderer, so
 *    registering handlers that never fire is harmless) and `BrowserWindow`
 *    statics that already tolerate a null/absent window.
 *  - THROWING stubs for everything else, so any un-abstracted Electron reach
 *    (safeStorage, net, dialog, real BrowserWindow construction, …) fails loudly
 *    with a clear message instead of crashing deep in Chromium init. This keeps
 *    "is the server truly Electron-free" a testable invariant.
 */
function unavailable(name: string): never {
  throw new Error(
    `[orca-server] Electron API "${name}" is not available in the headless server. ` +
      'This usage must be routed through a host abstraction (AppEnvironment, ' +
      'SecretStore, managedFetch) instead of importing it from "electron".'
  )
}

function throwingProxy(label: string): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        return unavailable(`${label}.${String(prop)}`)
      }
    }
  )
}

// ipcMain: a headless server registers PTY/runtime handlers against this, but no
// renderer ever sends to them. Every method is a no-op; `.handle` returns void.
const noopIpcMain = {
  handle: () => {},
  handleOnce: () => {},
  on: () => noopIpcMain,
  once: () => noopIpcMain,
  off: () => noopIpcMain,
  addListener: () => noopIpcMain,
  removeListener: () => noopIpcMain,
  removeHandler: () => {},
  removeAllListeners: () => noopIpcMain,
  emit: () => false,
  listeners: () => [],
  listenerCount: () => 0
}

// BrowserWindow: the runtime guards `if (!BrowserWindow?.fromId)` and tolerates a
// null window, so a benign static surface is safe. Constructing a real window
// (offscreen browser backend) is NOT installed headless, so `new BrowserWindow`
// throws — surfacing any accidental headless browser-pane attempt.
const BrowserWindowShim = function BrowserWindow(): never {
  return unavailable('new BrowserWindow()')
} as unknown as {
  (): never
  fromId: () => null
  getAllWindows: () => []
  fromWebContents: () => null
}
BrowserWindowShim.fromId = () => null
BrowserWindowShim.getAllWindows = () => []
BrowserWindowShim.fromWebContents = () => null

export const ipcMain = noopIpcMain
export const BrowserWindow = BrowserWindowShim

// app: delegate the safe, headless-meaningful methods (paths, version, packaged
// flag, lifecycle) to the AppEnvironment the node server installs. This makes
// the ~40 modules that only use app for `getPath('userData')` etc. work headless
// without touching each file, while GUI-only members (dock, whenReady-as-window,
// setAboutPanelOptions, badge, …) still throw so the server can't lean on them.
// Imported lazily to avoid a load-order cycle (shim is the electron alias).
const appShim = new Proxy(
  {},
  {
    get(_t, prop) {
      const name = String(prop)
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- lazy to dodge cycle
      const { getAppEnvironment, hasAppEnvironment } = require('../../shared/app-environment')
      switch (name) {
        case 'getPath':
          return (n: string) => getAppEnvironment().getPath(n)
        case 'getAppPath':
          return () => getAppEnvironment().getAppPath()
        case 'getVersion':
          return () => getAppEnvironment().getVersion()
        case 'getName':
          return () => 'Orca'
        case 'isPackaged':
          return hasAppEnvironment() ? getAppEnvironment().isPackaged() : true
        case 'getAppMetrics':
          return () => getAppEnvironment().getAppMetrics()
        case 'on':
        case 'once':
        case 'off':
        case 'removeListener':
          // Lifecycle listeners are harmless no-ops on a server (will-quit is
          // wired via NodeAppEnvironment's signal handlers instead).
          return () => appShim
        case 'quit':
          return () => getAppEnvironment().quit()
        case 'exit':
          return (code?: number) => getAppEnvironment().exit(code)
        case 'relaunch':
          return () => getAppEnvironment().relaunch()
        default:
          return unavailable(`app.${name}`)
      }
    }
  }
)
export const app = appShim
export const webContents = throwingProxy('webContents')
export const net = throwingProxy('net')
export const session = throwingProxy('session')
export const safeStorage = throwingProxy('safeStorage')
export const dialog = throwingProxy('dialog')
export const shell = throwingProxy('shell')
export const Menu = throwingProxy('Menu')
export const Tray = throwingProxy('Tray')
export const Notification = throwingProxy('Notification')
export const powerMonitor = throwingProxy('powerMonitor')
export const powerSaveBlocker = throwingProxy('powerSaveBlocker')
export const nativeTheme = throwingProxy('nativeTheme')
export const nativeImage = throwingProxy('nativeImage')
export const screen = throwingProxy('screen')
export const clipboard = throwingProxy('clipboard')
export const systemPreferences = throwingProxy('systemPreferences')

export default throwingProxy('default')
