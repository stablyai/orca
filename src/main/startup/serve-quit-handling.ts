import { isQuittingForUpdate } from '../updater'
import { quitFromUserCommand } from './main-window-actions'
import { quitProcess } from './process-quit-request'
import { installServeNativeQuitGuard } from './serve-native-quit-guard'
import { registerServeSignalHandlers } from './serve-signal-handlers'

/**
 * Signals end a serve host; a user or OS-native Quit only closes its desktop windows (#15537).
 * Why after app ready: these Node listeners then preempt Electron's native SIGTERM/SIGINT quit,
 * so the native-quit guard only ever sees user and OS terminates.
 */
export function installServeQuitHandling(): void {
  // Why every attempt reaches app.quit(): a page beforeunload can veto an earlier signal.
  registerServeSignalHandlers(process, quitProcess)
  installServeNativeQuitGuard({
    platform: process.platform,
    isQuittingForUpdate,
    closeDesktopWindows: quitFromUserCommand
  })
}
