import type { WebContents } from 'electron'
import type { BrowserScreencastPointer } from '../../../../shared/browser/runtime/runtime-browser-contracts'

type GuestPointer = {
  pointer: BrowserScreencastPointer
  listeners: Set<(pointer: BrowserScreencastPointer) => void>
}

// Electron reports a cursor only when it changes, so a guest is followed for its whole life:
// a stream that starts later still learns the cursor already showing.
const guestPointers = new WeakMap<WebContents, GuestPointer>()

function followGuestPointer(guest: WebContents): GuestPointer {
  const existing = guestPointers.get(guest)
  if (existing) {
    return existing
  }
  // `pointer` is Electron's name for the arrow.
  const followed: GuestPointer = {
    pointer: { cursor: 'pointer', targetUrl: '' },
    listeners: new Set()
  }
  const update = (next: Partial<BrowserScreencastPointer>): void => {
    const merged = { ...followed.pointer, ...next }
    if (
      merged.cursor === followed.pointer.cursor &&
      merged.targetUrl === followed.pointer.targetUrl
    ) {
      return
    }
    followed.pointer = merged
    for (const listener of followed.listeners) {
      listener(merged)
    }
  }
  guest.on('cursor-changed', (_event, type) => update({ cursor: type }))
  guest.on('update-target-url', (_event, url) => update({ targetUrl: url }))
  // A guest that dies under a hovered link never reports leaving it.
  guest.on('render-process-gone', () => update({ cursor: 'pointer', targetUrl: '' }))
  guestPointers.set(guest, followed)
  return followed
}

/** Follows the guest's cursor and hovered link, which viewers need since they draw only frames. */
export function watchGuestPointer(
  guest: WebContents,
  onChange: (pointer: BrowserScreencastPointer) => void
): { current: () => BrowserScreencastPointer; stop: () => void } {
  const followed = followGuestPointer(guest)
  followed.listeners.add(onChange)
  return {
    current: () => followed.pointer,
    stop: () => {
      followed.listeners.delete(onChange)
    }
  }
}
