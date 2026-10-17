type GuestMouseHistoryDirection = 'back' | 'forward'

type GuestMouseEvent = { preventDefault: () => void }
// Why `button: string`: Electron reports 'back'/'forward' here, but its typings list only left/middle/right.
type GuestMouseInput = { type: string; button?: string }
type GuestMouseListener = (event: GuestMouseEvent, mouse: GuestMouseInput) => void

type GuestMouseEventSource = {
  on: (event: 'before-mouse-event', listener: GuestMouseListener) => unknown
  off: (event: 'before-mouse-event', listener: GuestMouseListener) => unknown
}

function resolveDirection(mouse: GuestMouseInput): GuestMouseHistoryDirection | null {
  if (mouse.type !== 'mouseDown' && mouse.type !== 'mouseUp') {
    return null
  }
  return mouse.button === 'back' || mouse.button === 'forward' ? mouse.button : null
}

/**
 * Chromium sends an unconsumed mouse Back/Forward to the outermost WebContents, Orca's window,
 * not the `<webview>` guest under the pointer. Route it to the guest's own history instead.
 */
export function setupGuestMouseHistoryForwarding(args: {
  browserTabId: string
  guest: GuestMouseEventSource
  resolveRenderer: (
    browserTabId: string
  ) => { send: (channel: string, payload: unknown) => void } | null
}): () => void {
  const { browserTabId, guest, resolveRenderer } = args
  const handler: GuestMouseListener = (event, mouse) => {
    const direction = resolveDirection(mouse)
    if (!direction) {
      return
    }
    event.preventDefault()
    if (mouse.type === 'mouseUp') {
      resolveRenderer(browserTabId)?.send('ui:browserHistoryNavigate', {
        browserPageId: browserTabId,
        direction
      })
    }
  }
  guest.on('before-mouse-event', handler)
  return () => {
    try {
      guest.off('before-mouse-event', handler)
    } catch {
      // Why: best-effort — guest may already be destroyed during teardown.
    }
  }
}
