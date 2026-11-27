import { BrowserError } from '../browser-error'
import { browserNavigationError } from './browser-navigation-error'

export function waitForBrowserGuestLoad(
  guest: Electron.WebContents,
  start?: () => Promise<void>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => {
      clearTimeout(timer)
      guest.off('did-finish-load', loaded)
      guest.off('did-fail-load', failed)
      guest.off('did-stop-loading', loaded)
      guest.off('destroyed', destroyed)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const loaded = (): void => finish()
    const destroyed = (): void => finish(new Error('The browser page closed while loading'))
    const failed = (
      _event: Electron.Event,
      code: number,
      description: string,
      url: string,
      main: boolean
    ): void => {
      if (main && code !== -3) {
        finish(
          browserNavigationError(new BrowserError('browser_navigation_failed', description), url)
        )
      }
    }
    const timer = setTimeout(
      () =>
        finish(
          new BrowserError(
            'browser_navigation_failed',
            'The browser page did not finish loading. Try reloading it.'
          )
        ),
      30_000
    )
    guest.on('did-finish-load', loaded)
    guest.on('did-fail-load', failed)
    guest.once('destroyed', destroyed)
    if (start) {
      void start().then(loaded, (error: unknown) => {
        if (error && typeof error === 'object' && 'errno' in error && error.errno === -3) {
          // Aborted: a newer load runs to its stop, while a download or a cancel has already stopped.
          if (guest.isDestroyed() || guest.isLoadingMainFrame()) {
            guest.on('did-stop-loading', loaded)
          } else {
            loaded()
          }
          return
        }
        finish(browserNavigationError(error))
      })
    } else if (guest.isLoadingMainFrame()) {
      // isLoadingMainFrame stays true after did-finish-load until did-stop-loading, later in the same task.
      guest.on('did-stop-loading', loaded)
    } else {
      loaded()
    }
  })
}
