import type { BrowserWindow } from 'electron'
import { forgetBrowserPageGuestsGone } from './extensions/browser-extension-discarded-tabs'

/** Sent by the renderer's browser request bridge once its workspaces are restored. */
const TAB_REQUESTS_READY_CHANNEL = 'browser:tabRequestsReady'

let watchedWindow: BrowserWindow | null = null
let readyWindow: BrowserWindow | null = null
const waiters = new Set<(window: BrowserWindow | null) => void>()

/**
 * Follows whether Orca's main window can take browser tab requests. Extensions open tabs from
 * the moment they load, and agent commands wake hidden tabs right after a reload, before the
 * renderer listens or has restored its tabs; a request sent then is dropped and times out. Each
 * renderer document says it is ready once, so a reload resets this.
 */
export function watchBrowserMainWindowReadiness(window: BrowserWindow): void {
  watchedWindow = window
  readyWindow = null
  const contents = window.webContents
  contents.ipc.on(TAB_REQUESTS_READY_CHANNEL, () => {
    if (watchedWindow !== window || window.isDestroyed()) {
      return
    }
    readyWindow = window
    // Why: the guests a reload destroyed were not closes; their pages are restored, unloaded.
    forgetBrowserPageGuestsGone()
    for (const resolve of waiters) {
      resolve(window)
    }
  })
  const reset = (): void => {
    if (readyWindow === window) {
      readyWindow = null
    }
  }
  contents.on('did-navigate', reset)
  contents.on('render-process-gone', reset)
}

/** The main window once its renderer takes tab requests; null if that takes over `timeoutMs`. */
export function whenBrowserMainWindowReady(timeoutMs: number): Promise<BrowserWindow | null> {
  if (readyWindow && !readyWindow.isDestroyed()) {
    return Promise.resolve(readyWindow)
  }
  return new Promise((resolve) => {
    const done = (window: BrowserWindow | null): void => {
      clearTimeout(timer)
      waiters.delete(done)
      resolve(window)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    waiters.add(done)
  })
}
