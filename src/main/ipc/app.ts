import { app, ipcMain } from 'electron'
import { isWslAvailable } from '../wsl'

export type AppRuntimeFlags = {
  /** Whether the persistent terminal daemon was actually started this session.
   *  The renderer compares this against the current setting to decide whether
   *  a "restart required" banner needs to be shown on the Experimental pane. */
  daemonEnabledAtStartup: boolean
}

export type DaemonTransitionNotice = {
  /** Number of live daemon PTY sessions that were killed when the app booted
   *  with `experimentalTerminalDaemon: false` but discovered a leftover daemon
   *  from a previous session. Non-zero values are surfaced in a one-shot
   *  toast so the user knows background work was stopped. */
  killedCount: number
}

let runtimeFlags: AppRuntimeFlags = { daemonEnabledAtStartup: false }
let pendingDaemonTransitionNotice: DaemonTransitionNotice | null = null

export function setAppRuntimeFlags(flags: AppRuntimeFlags): void {
  runtimeFlags = flags
}

export function recordPendingDaemonTransitionNotice(notice: DaemonTransitionNotice): void {
  pendingDaemonTransitionNotice = notice
}

export function registerAppHandlers(): void {
  ipcMain.handle('app:getRuntimeFlags', (): AppRuntimeFlags => runtimeFlags)

  ipcMain.handle('app:consumeDaemonTransitionNotice', (): DaemonTransitionNotice | null => {
    // Why: one-shot consumption — clear after reading so the renderer's
    // post-hydration effect can't fire the same toast twice (e.g. after a
    // window reload during dev). The persisted `experimentalTerminalDaemonNoticeShown`
    // flag is the cross-session guard; this clear handles within-session races.
    const notice = pendingDaemonTransitionNotice
    pendingDaemonTransitionNotice = null
    return notice
  })

  ipcMain.handle('wsl:isAvailable', (): boolean => isWslAvailable())

  ipcMain.handle('app:relaunch', () => {
    // Why: small delay lets the renderer finish painting any "Restarting…"
    // UI state before the window tears down. `app.relaunch()` schedules a
    // spawn; `app.exit(0)` triggers the actual quit without invoking
    // before-quit handlers that could block on confirmation dialogs.
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 150)
  })
}
