import { isActivatingBrowserGuestInput } from './browser-guest-input-gesture'

const quietContents = new Set<number>()

export function isBrowserPagePromptQuiet(contents: Electron.WebContents): boolean {
  return quietContents.has(contents.id)
}

// Suppress repeated modal prompts after dismissal until the user acts on the page.
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
  // Toolbar navigation has no initiating frame.
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
