import { ipcMain } from 'electron'
import { BROWSER_GUEST_PAGE_VISIBILITY_CHANNEL } from '../../../../shared/browser/guest-lifecycle/browser-guest-page-visibility'

// Electron's webview defines document.visibilityState in every frame from this message, and only sends it
// to the main frame when the embedder window is shown, hidden or minimized, so a background tab stays
// 'visible' (#44520).
const ELECTRON_GUEST_VISIBILITY_CHANNEL = 'GUEST_INSTANCE_VISIBILITY_CHANGE'

const pageVisibility = new WeakMap<Electron.WebContents, DocumentVisibilityState>()
// Electron's last window value for the guest: a hidden or minimized window hides every page in it.
const hiddenWindows = new WeakSet<Electron.WebContents>()
const followedGuests = new WeakSet<Electron.WebContents>()

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
    if (frame === guest.mainFrame) {
      pageVisibility.set(guest, state)
      followWindowVisibility(guest)
    }
    sendInternal(frame, hiddenWindows.has(guest) ? 'hidden' : state)
  })
}

function sendInternal(target: object, state: DocumentVisibilityState): void {
  const send: unknown = Reflect.get(target, '_sendInternal')
  if (typeof send === 'function') {
    Reflect.apply(send, target, [ELECTRON_GUEST_VISIBILITY_CHANNEL, state])
  }
}

/** Electron's window broadcast and its dom-ready replay would otherwise undo the page's value. */
function followWindowVisibility(guest: Electron.WebContents): void {
  const original: unknown = Reflect.get(guest, '_sendInternal')
  if (followedGuests.has(guest) || typeof original !== 'function') {
    return
  }
  followedGuests.add(guest)
  Reflect.set(guest, '_sendInternal', (channel: string, ...args: unknown[]) => {
    if (channel === ELECTRON_GUEST_VISIBILITY_CHANNEL) {
      if (args[0] === 'hidden') {
        hiddenWindows.add(guest)
      } else {
        hiddenWindows.delete(guest)
        args = [pageVisibility.get(guest) ?? args[0]]
      }
    }
    return Reflect.apply(original, guest, [channel, ...args])
  })
}
