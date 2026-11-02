import { isQuittingForUpdate } from '../updater'
import { quitFromUserCommand } from './main-window-actions'
import { quitProcess } from './process-quit-request'
import { installServeNativeQuitGuard } from './serve-native-quit-guard'
import { registerServeSignalHandlers } from './serve-signal-handlers'

/** Register after ready to reclaim Node signals from Electron native handling; signals terminate serve while user Quit closes desktop windows (#15537). */
export function installServeQuitHandling(): void {
  // Retry app.quit for every signal: renderer beforeunload may have vetoed the previous attempt.
  registerServeSignalHandlers(process, quitProcess)
  installServeNativeQuitGuard({
    platform: process.platform,
    isQuittingForUpdate,
    closeDesktopWindows: quitFromUserCommand
  })
}
