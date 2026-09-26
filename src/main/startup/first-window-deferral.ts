import { app, type BrowserWindow } from 'electron'

/**
 * Run `task` once the first window can paint, or after `fallbackMs` if it never does.
 *
 * For startup work nothing on the critical path consumes: a probe or a disk sweep started before the
 * window exists competes with window creation for the same main thread and libuv threadpool, and the
 * user sees that as the app being slow to open.
 *
 * Why a fallback as well as the window event: `ready-to-show` can fail to fire at all when the
 * GPU/driver cannot present (see main-window-state-lifecycle), and headless serve has no window.
 */
export function runAfterFirstWindowShown(task: () => void, fallbackMs: number): void {
  let ran = false
  const run = (): void => {
    if (ran) {
      return
    }
    ran = true
    clearTimeout(fallback)
    // Why setImmediate: keep the work off the event handler that reveals the window, so it paints first.
    // Why the guard: off whenReady's promise chain a synchronous throw is an uncaughtException, and
    // installUncaughtPipeErrorGuard re-throws those fatally — deferred startup chores are never that.
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
