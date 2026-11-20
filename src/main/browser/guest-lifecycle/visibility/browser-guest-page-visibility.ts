import { ipcMain } from 'electron'
import { BROWSER_GUEST_PAGE_VISIBILITY_CHANNEL } from '../../../../shared/browser/guest-lifecycle/browser-guest-page-visibility'

// Electron's webview defines document.visibilityState from this message, which it sends only when the
// embedder window is shown, hidden or minimized, so a background tab stays 'visible' (#44520).
const ELECTRON_GUEST_VISIBILITY_CHANNEL = 'GUEST_INSTANCE_VISIBILITY_CHANGE'

type InternalSend = (channel: string, ...args: unknown[]) => void

const pageVisibility = new WeakMap<Electron.WebContents, DocumentVisibilityState>()
const electronSends = new WeakMap<Electron.WebContents, InternalSend>()

/** Makes each reporting guest's document.visibilityState follow Chromium's visibility for it; once per app. */
export function listenForBrowserGuestPageVisibility(): void {
  ipcMain.on(BROWSER_GUEST_PAGE_VISIBILITY_CHANNEL, (event, state: unknown) => {
    const guest = event.sender
    // A document unloading after a cross-process navigation reports 'hidden' late; only the current one counts.
    if (
      (state !== 'visible' && state !== 'hidden') ||
      event.senderFrame !== guest.mainFrame ||
      guest.getType() !== 'webview'
    ) {
      return
    }
    pageVisibility.set(guest, state)
    followPageVisibility(guest)?.(ELECTRON_GUEST_VISIBILITY_CHANNEL, state)
  })
}

function followPageVisibility(guest: Electron.WebContents): InternalSend | null {
  const existing = electronSends.get(guest)
  if (existing) {
    return existing
  }
  const original: unknown = Reflect.get(guest, '_sendInternal')
  if (typeof original !== 'function') {
    return null
  }
  const send: InternalSend = (channel, ...args) =>
    Reflect.apply(original, guest, [channel, ...args])
  // Electron's window-only value, sent on show/hide/minimize and replayed at dom-ready, would undo the page's.
  const follow: InternalSend = (channel, ...args) =>
    channel === ELECTRON_GUEST_VISIBILITY_CHANNEL
      ? send(channel, pageVisibility.get(guest) ?? args[0])
      : send(channel, ...args)
  Reflect.set(guest, '_sendInternal', follow)
  // Electron drops messages that reach a document before its element exists.
  guest.on('dom-ready', () => {
    const state = pageVisibility.get(guest)
    if (state) {
      send(ELECTRON_GUEST_VISIBILITY_CHANNEL, state)
    }
  })
  electronSends.set(guest, send)
  return send
}
