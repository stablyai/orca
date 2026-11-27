import { webContents, webFrameMain } from 'electron'
import { getBrowserExtensionDocumentId } from '../tabs-and-windows/browser-extension-document-ids'
import type { ContextMenuTarget } from './browser-extension-context-menu-target'

export type ContextMenuSource = {
  guestId: number
  documentId: string
  frame?: { processId: number; routingId: number; documentId: string }
}

export function captureContextMenuSource(
  guest: Electron.WebContents,
  frame?: Electron.WebFrameMain | null
): ContextMenuSource | null {
  if (
    guest.isDestroyed() ||
    (frame && (frame.isDestroyed() || webContents.fromFrame(frame)?.id !== guest.id))
  ) {
    return null
  }
  return {
    guestId: guest.id,
    documentId: getBrowserExtensionDocumentId(guest.mainFrame),
    ...(frame?.parent
      ? {
          frame: {
            processId: frame.processId,
            routingId: frame.routingId,
            documentId: getBrowserExtensionDocumentId(frame)
          }
        }
      : {})
  }
}

export function resolveContextMenuCheckTarget(
  source: ContextMenuSource,
  session: Electron.Session,
  target: ContextMenuTarget
): ContextMenuTarget | null {
  const guest = webContents.fromId(source.guestId)
  if (
    !guest ||
    guest.isDestroyed() ||
    guest.session !== session ||
    getBrowserExtensionDocumentId(guest.mainFrame) !== source.documentId
  ) {
    return null
  }
  const frame = source.frame
    ? webFrameMain.fromId(source.frame.processId, source.frame.routingId)
    : null
  if (
    source.frame &&
    (!frame ||
      frame.isDestroyed() ||
      webContents.fromFrame(frame)?.id !== guest.id ||
      getBrowserExtensionDocumentId(frame) !== source.frame.documentId)
  ) {
    return null
  }
  return {
    ...target,
    pageUrl: guest.getURL(),
    ...(frame ? { frameUrl: frame.url } : {})
  }
}
