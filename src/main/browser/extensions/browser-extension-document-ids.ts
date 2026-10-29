import { randomBytes } from 'node:crypto'

/**
 * Chrome's documentId: an opaque id for one document in one frame. A frame gets a new one when it
 * commits a cross-document navigation and keeps it through same-document (history/fragment)
 * changes. Keyed by frame-tree-node id, which survives the frame's process swaps.
 */
const documentIdByFrameTreeNodeId = new Map<number, string>()

function newDocumentId(): string {
  return randomBytes(16).toString('hex').toUpperCase()
}

/** A cross-document commit in this frame: the old document's id is gone for good. */
export function startBrowserExtensionDocument(frameTreeNodeId: number): string {
  const id = newDocumentId()
  documentIdByFrameTreeNodeId.set(frameTreeNodeId, id)
  return id
}

/** The frame's current document; a frame Orca never saw commit (initial about:blank) gets one now. */
export function getBrowserExtensionDocumentId(frameTreeNodeId: number): string {
  return (
    documentIdByFrameTreeNodeId.get(frameTreeNodeId) ??
    startBrowserExtensionDocument(frameTreeNodeId)
  )
}

export function forgetBrowserExtensionDocuments(frameTreeNodeIds: Iterable<number>): void {
  for (const id of frameTreeNodeIds) {
    documentIdByFrameTreeNodeId.delete(id)
  }
}
