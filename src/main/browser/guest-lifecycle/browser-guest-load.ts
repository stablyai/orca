import { BrowserError } from '../browser-error'

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
      _url: string,
      main: boolean
    ): void => {
      if (main && code !== -3) {
        finish(new BrowserError('browser_navigation_failed', description))
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
          // Superseded: wait for the navigation that replaced it. Stopped: nothing will load.
          if (!guest.isDestroyed() && !guest.isLoadingMainFrame()) {
            loaded()
          }
          return
        }
        finish(error instanceof Error ? error : new Error('The browser page could not load'))
      })
    } else if (guest.isLoadingMainFrame()) {
      // isLoadingMainFrame stays true after did-finish-load until did-stop-loading, later in the same task.
      guest.on('did-stop-loading', loaded)
    } else {
      loaded()
    }
  })
}
