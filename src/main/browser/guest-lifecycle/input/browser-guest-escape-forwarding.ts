import { isAgentInjectingInput } from '../../cdp/input/agent-input-injection'

type GuestEscapeTarget = { browserPageId: string; renderer: Electron.WebContents }

// A focused page keeps its keys, so Orca modes over it (grab, find, password list) never see Escape.
export function setupGuestEscapeForwarding(args: {
  guest: Electron.WebContents
  resolveTarget: () => GuestEscapeTarget | null
  hasActiveGrabOp: (browserPageId: string) => boolean
}): () => void {
  const { guest, resolveTarget, hasActiveGrabOp } = args
  const handler = (event: Electron.Event, input: Electron.Input): void => {
    if (
      input.type !== 'keyDown' ||
      input.key !== 'Escape' ||
      input.isAutoRepeat ||
      input.meta ||
      input.control ||
      input.alt ||
      input.shift ||
      // Agent-injected keys must not end the user's modes (#20595).
      isAgentInjectingInput(guest)
    ) {
      return
    }
    const target = resolveTarget()
    if (!target || target.renderer.isDestroyed()) {
      return
    }
    // Like C/S during a pick, the key that ends the pick is not also the page's.
    if (hasActiveGrabOp(target.browserPageId)) {
      event.preventDefault()
    }
    target.renderer.send('browser:guestEscape', { browserPageId: target.browserPageId })
  }
  guest.on('before-input-event', handler)
  return () => {
    try {
      guest.off('before-input-event', handler)
    } catch {
      // The guest may already be destroyed.
    }
  }
}
