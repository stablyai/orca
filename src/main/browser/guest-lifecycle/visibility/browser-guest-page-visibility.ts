import { ipcMain } from 'electron'
import { BROWSER_GUEST_PAGE_VISIBILITY_CHANNEL } from '../../../../shared/browser/guest-lifecycle/browser-guest-page-visibility'

// Electron's webview defines document.visibilityState in every frame from this message, and only sends it
// to the main frame when the embedder window is shown, hidden or minimized, so a background tab stays
// 'visible' (#44520).
const ELECTRON_GUEST_VISIBILITY_CHANNEL = 'GUEST_INSTANCE_VISIBILITY_CHANGE'

// The main frame's last page value and Electron's last window value; a hidden or minimized window hides the page.
type FollowedGuest = { page: DocumentVisibilityState; windowHidden: boolean }
const followedGuests = new WeakMap<Electron.WebContents, FollowedGuest>()

/** Makes each reporting frame's document.visibilityState follow Chromium's visibility for it; once per app. */
export function listenForBrowserGuestPageVisibility(): void {
  ipcMain.on(BROWSER_GUEST_PAGE_VISIBILITY_CHANNEL, (event, state: unknown) => {
    const guest = event.sender
    const frame = event.senderFrame
    // A document unloading after a navigation reports 'hidden' late from its detached frame.
    if (
      (state !== 'visible' && state !== 'hidden') ||
      !frame ||
      frame.detached ||
      guest.getType() !== 'webview'
    ) {
      return
    }
    if (frame !== guest.mainFrame) {
      // Electron's window broadcast never reaches subframes, so nothing would undo a window 'hidden' there.
      sendInternal(frame, state)
      return
    }
    const followed = followWindowVisibility(guest, state)
    sendInternal(frame, followed?.windowHidden ? 'hidden' : state)
  })
}

function sendInternal(target: object, state: DocumentVisibilityState): void {
  const send: unknown = Reflect.get(target, '_sendInternal')
  if (typeof send === 'function') {
    Reflect.apply(send, target, [ELECTRON_GUEST_VISIBILITY_CHANNEL, state])
  }
}

/** Electron's window broadcast and its dom-ready replay would otherwise undo the page's value. */
function followWindowVisibility(
  guest: Electron.WebContents,
  page: DocumentVisibilityState
): FollowedGuest | null {
  const existing = followedGuests.get(guest)
  if (existing) {
    existing.page = page
    return existing
  }
  const original: unknown = Reflect.get(guest, '_sendInternal')
  if (typeof original !== 'function') {
    return null
  }
  const followed: FollowedGuest = { page, windowHidden: false }
  followedGuests.set(guest, followed)
  Reflect.set(guest, '_sendInternal', (channel: string, ...args: unknown[]) => {
    if (channel === ELECTRON_GUEST_VISIBILITY_CHANNEL) {
      followed.windowHidden = args[0] === 'hidden'
      args = [followed.windowHidden ? 'hidden' : followed.page]
    }
    return Reflect.apply(original, guest, [channel, ...args])
  })
  return followed
}
