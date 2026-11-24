import { app } from 'electron'
import { mainProcessState as state } from '../main-process-state'
import { shouldQuitWhenAllWindowsClosed } from './window-all-closed-quit-policy'

export function installWindowAllClosedHandler(): void {
  app.on('window-all-closed', () => {
    // Keep serve RPC alive after disposable windows close; re-trigger macOS quit after renderer buffer-capture deferral.
    if (
      shouldQuitWhenAllWindowsClosed({
        platform: process.platform,
        isQuitting: state.isQuitting,
        isServeMode: state.isServeMode,
        hasOpenedMainWindow: state.hasOpenedMainWindow
      })
    ) {
      app.quit()
    }
  })
}
