import { onBrowserExtensionPageReadiness } from './browser-extension-profile-demand'

const pending = new WeakMap<Electron.WebContents, () => void>()

/** Keep the original intent until current prerequisites settle, another navigation replaces it, or the page dies. */
export function navigateBrowserExtensionPage(
  contents: Electron.WebContents,
  navigate: () => Promise<unknown>
): Promise<void> {
  pending.get(contents)?.()
  return new Promise((resolve, reject) => {
    let current: Promise<void> | undefined
    let unsubscribe = (): void => {}
    const cleanup = (): void => {
      unsubscribe()
      contents.removeListener('destroyed', cancel)
      contents.removeListener('did-start-navigation', superseded)
      if (pending.get(contents) === cancel) {
        pending.delete(contents)
      }
    }
    const superseded = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
    ): void => {
      if (event.isMainFrame && !event.isSameDocument) {
        cancel()
      }
    }
    const cancel = (): void => {
      cleanup()
      resolve()
    }
    pending.set(contents, cancel)
    contents.once('destroyed', cancel)
    contents.on('did-start-navigation', superseded)
    unsubscribe = onBrowserExtensionPageReadiness(contents, (ready) => {
      current = ready
      void ready.then(
        () => {
          if (current !== ready || pending.get(contents) !== cancel || contents.isDestroyed()) {
            return
          }
          cleanup()
          void navigate().then(() => resolve(), reject)
        },
        () => {
          /* A replacement owner supplies the next prerequisite. */
        }
      )
    })
    if (contents.isDestroyed()) {
      cancel()
    }
  })
}
