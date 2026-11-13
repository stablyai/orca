import { getBrowserExtensionDocumentId } from './browser-extension-document-ids'

/**
 * Chrome frame ids: 0 for a tab's main frame, the frame-tree-node id otherwise. Electron's own
 * content-script `sender.frameId` uses the same numbering, so tabs.sendMessage targets line up.
 */
export function chromeFrameId(frame: Electron.WebFrameMain): number {
  return frame.parent ? frame.frameTreeNodeId : 0
}

function chromeParentFrameId(frame: Electron.WebFrameMain): number {
  return frame.parent ? chromeFrameId(frame.parent) : -1
}

/** Chrome's frame fields; `documentId` is left out where the document does not exist yet. */
export function chromeFrameDocument(frame: Electron.WebFrameMain, withDocument: boolean) {
  return {
    frameId: chromeFrameId(frame),
    parentFrameId: chromeParentFrameId(frame),
    ...(withDocument ? { documentId: getBrowserExtensionDocumentId(frame) } : {}),
    ...(frame.parent ? { parentDocumentId: getBrowserExtensionDocumentId(frame.parent) } : {}),
    frameType: frame.parent ? ('sub_frame' as const) : ('outermost_frame' as const),
    documentLifecycle: 'active' as const
  }
}
