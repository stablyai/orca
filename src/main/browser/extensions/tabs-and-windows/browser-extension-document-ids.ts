import { randomBytes } from 'node:crypto'

/**
 * Chrome's documentId: an opaque id for one document in one frame. A frame gets a new one when it
 * commits a cross-document navigation and keeps it through same-document (history/fragment)
 * changes. Electron keeps the same WebFrameMain wrapper through process swaps; weak keys let
 * deleted frames release their records without waiting for the guest to close.
 */
const documentIdByFrame = new WeakMap<Electron.WebFrameMain, string>()

function newDocumentId(): string {
  return randomBytes(16).toString('hex').toUpperCase()
}

/** A cross-document commit in this frame: the old document's id is gone for good. */
export function startBrowserExtensionDocument(frame: Electron.WebFrameMain): string {
  const id = newDocumentId()
  documentIdByFrame.set(frame, id)
  return id
}

/** The frame's current document; a frame Orca never saw commit (initial about:blank) gets one now. */
export function getBrowserExtensionDocumentId(frame: Electron.WebFrameMain): string {
  return documentIdByFrame.get(frame) ?? startBrowserExtensionDocument(frame)
}
