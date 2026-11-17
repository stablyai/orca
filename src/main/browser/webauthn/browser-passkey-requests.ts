import {
  ipcMain,
  type IpcMainEvent,
  type Session,
  type WebContents,
  type WebFrameMain,
  webFrameMain
} from 'electron'
import {
  BROWSER_PASSKEY_REQUEST_CANCEL_CHANNEL,
  BROWSER_PASSKEY_REQUEST_PENDING_CHANNEL,
  BROWSER_PASSKEY_REQUEST_PRELOAD_FILE
} from '../../../shared/browser-passkey-request'
import type { BrowserPasskeyRequest } from '../../../shared/browser/runtime/runtime-browser-contracts'
import {
  registerBrowserSessionFramePreload,
  unregisterBrowserSessionFramePreload
} from '../sessions/browser-session-frame-preloads'

const PRELOAD_ID = 'orca-browser-passkey-request'
// Frames waiting on a passkey request, by guest WebContents id and frame tree node.
const pendingFramesByGuest = new Map<number, Map<number, WebFrameMain>>()

function framesOf(guest: WebContents): Map<number, WebFrameMain> {
  const existing = pendingFramesByGuest.get(guest.id)
  if (existing) {
    return existing
  }
  const frames = new Map<number, WebFrameMain>()
  pendingFramesByGuest.set(guest.id, frames)
  // A new document can't inherit the old one's request; a new top document replaces every frame.
  guest.on(
    'did-frame-navigate',
    (_event, _url, _code, _status, isMainFrame, processId, routingId) => {
      if (isMainFrame) {
        frames.clear()
        return
      }
      if (frames.size === 0) {
        return
      }
      const navigated = webFrameMain.fromId(processId, routingId)
      if (navigated) {
        frames.delete(navigated.frameTreeNodeId)
      }
    }
  )
  guest.once('destroyed', () => pendingFramesByGuest.delete(guest.id))
  return frames
}

// A removed iframe never reports that its request settled.
function pruneRemovedFrames(frames: Map<number, WebFrameMain>): void {
  for (const [node, frame] of frames) {
    if (frame.isDestroyed() || frame.detached) {
      frames.delete(node)
    }
  }
}

function onPendingChanged(event: IpcMainEvent, pending: unknown): void {
  const frame = event.senderFrame
  if (!frame || typeof pending !== 'boolean') {
    return
  }
  const frames = pending ? framesOf(event.sender) : pendingFramesByGuest.get(event.sender.id)
  if (!frames) {
    return
  }
  pruneRemovedFrames(frames)
  if (pending) {
    frames.set(frame.frameTreeNodeId, frame)
  } else {
    frames.delete(frame.frameTreeNodeId)
  }
}

/** Receives what every watched page reports; once per app. */
export function listenForBrowserPasskeyRequests(): void {
  ipcMain.on(BROWSER_PASSKEY_REQUEST_PENDING_CHANNEL, onPendingChanged)
}

/** Watches the session's pages for passkey requests, which Electron neither shows nor reports. */
export function watchBrowserPasskeyRequests(browserSession: Session): void {
  if (
    !registerBrowserSessionFramePreload(
      browserSession,
      PRELOAD_ID,
      BROWSER_PASSKEY_REQUEST_PRELOAD_FILE
    )
  ) {
    console.warn('[browser-webauthn] Passkey request preload is missing')
  }
}

export function unwatchBrowserPasskeyRequests(browserSession: Session): void {
  unregisterBrowserSessionFramePreload(browserSession, PRELOAD_ID)
}

function livePendingFrames(webContentsId: number): WebFrameMain[] {
  const frames = pendingFramesByGuest.get(webContentsId)
  if (!frames) {
    return []
  }
  pruneRemovedFrames(frames)
  return [...frames.values()]
}

/** The origin of a frame on this page that is waiting on a passkey request, if any. */
export function getBrowserPasskeyRequest(webContentsId: number): BrowserPasskeyRequest | undefined {
  const [frame] = livePendingFrames(webContentsId)
  return frame ? { origin: frame.origin } : undefined
}

/** Rejects the page's pending passkey requests as cancelled; false when none was pending. */
export function cancelBrowserPasskeyRequests(webContentsId: number): boolean {
  const frames = livePendingFrames(webContentsId)
  for (const frame of frames) {
    frame.send(BROWSER_PASSKEY_REQUEST_CANCEL_CHANNEL)
  }
  return frames.length > 0
}
