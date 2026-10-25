import { app } from 'electron'

// Sticky: will-quit's second pass and a deferred updater quit re-enter before-quit.
let processQuitRequested = false

/**
 * Ends the process for a reason other than a user Quit: a signal, a supervisor, a relaunch.
 * Why not bare app.quit(): a serve host turns an unmarked macOS quit into closing its windows.
 */
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
