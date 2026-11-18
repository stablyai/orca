import { app } from 'electron'

// Sticky: will-quit's second pass and a deferred updater quit re-enter before-quit.
let processQuitRequested = false

/** Mark process-level signal/supervisor/relaunch quit; an unmarked macOS serve quit only closes desktop windows. */
export function quitProcess(): void {
  processQuitRequested = true
  app.quit()
}

export function markProcessQuitRequested(): void {
  processQuitRequested = true
}

export function isProcessQuitRequested(): boolean {
  return processQuitRequested
}

export function resetProcessQuitRequestForTest(): void {
  processQuitRequested = false
}
