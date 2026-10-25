import { app, type BrowserWindow } from 'electron'

/** Defer noncritical disk/probe work until first paint; fallback handles headless serve and GPU failures that never emit ready-to-show. */
export function runAfterFirstWindowShown(task: () => void, fallbackMs: number): void {
  let ran = false
  const run = (): void => {
    if (ran) {
      return
    }
    ran = true
    clearTimeout(fallback)
    // Yield so the window paints first; catch deferred failures because uncaughtException is fatal outside the readiness chain.
    setImmediate(() => {
      try {
        task()
      } catch (error) {
        console.warn('[startup] deferred first-window task failed', error)
      }
    })
  }
  const fallback = setTimeout(run, fallbackMs)
  fallback.unref?.()
  app.once('browser-window-created', (_event: Electron.Event, window: BrowserWindow) => {
    window.once('ready-to-show', run)
  })
}
