import { isActivatingBrowserGuestInput } from './browser-guest-input-gesture'

// Contents ids whose last prompt was declined or ignored; they cannot prompt until the user acts.
const quietContents = new Set<number>()

export function isBrowserPagePromptQuiet(contents: Electron.WebContents): boolean {
  return quietContents.has(contents.id)
}

/**
 * Why: prompts are app-modal, so a page that asks again after every Cancel (a deep-link loop, a 401
 * page that reloads itself) would lock the user out of Orca. As in Chrome, it stays quiet until the
 * user clicks or types in it, or starts a navigation from Orca's toolbar.
 */
export function quietBrowserPagePrompts(contents: Electron.WebContents): void {
  const { id } = contents
  if (contents.isDestroyed() || quietContents.has(id)) {
    return
  }
  quietContents.add(id)
  const release = (): void => {
    quietContents.delete(id)
    try {
      contents.off('input-event', onInput)
      contents.off('did-start-navigation', onNavigation)
      contents.off('destroyed', release)
    } catch {
      // Contents may already be destroyed.
    }
  }
  const onInput = (_event: Electron.Event, input: Electron.InputEvent): void => {
    if (isActivatingBrowserGuestInput(input)) {
      release()
    }
  }
  // Why: the address bar, reload and back/forward start navigations no frame initiated.
  const onNavigation = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
  ): void => {
    if (details.isMainFrame && !details.initiator) {
      release()
    }
  }
  contents.on('input-event', onInput)
  contents.on('did-start-navigation', onNavigation)
  contents.once('destroyed', release)
}
