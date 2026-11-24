import { z } from 'zod'
import { getBrowserExtensionDocumentId } from '../tabs-and-windows/browser-extension-document-ids'
import { findBrowserExtensionSidePanels } from './browser-extension-side-panel-host'

export const browserExtensionContextFilterSchema = z
  .object({
    contextIds: z.array(z.string()).optional(),
    contextTypes: z.array(z.string()).optional(),
    documentIds: z.array(z.string()).optional(),
    documentOrigins: z.array(z.string()).optional(),
    documentUrls: z.array(z.string()).optional(),
    frameIds: z.array(z.number()).optional(),
    incognito: z.boolean().optional(),
    tabIds: z.array(z.number()).optional(),
    windowIds: z.array(z.number()).optional()
  })
  .loose()

type ContextFilter = z.infer<typeof browserExtensionContextFilterSchema>

type SidePanelContext = {
  contextId: string
  contextType: 'SIDE_PANEL'
  documentId: string
  documentOrigin: string
  documentUrl: string
  frameId: number
  incognito: boolean
  tabId: number
  windowId: number
}

/** The live panel documents of one extension, for runtime.getContexts. */
function listBrowserExtensionSidePanelGuests(
  profileId: string,
  extensionId: string
): { guest: Electron.WebContents; tabId: number | null }[] {
  return findBrowserExtensionSidePanels(profileId, extensionId).flatMap((panel) =>
    panel.guest && !panel.guest.isDestroyed() ? [{ guest: panel.guest, tabId: panel.tabId }] : []
  )
}

function matches<Value>(allowed: readonly Value[] | undefined, value: Value): boolean {
  return allowed === undefined || allowed.includes(value)
}

/**
 * Electron's runtime.getContexts never sees a side panel (Orca hosts it), so Orca adds one
 * SIDE_PANEL context per open panel document. As in Chrome, the panel is not a tab and its own
 * WebContents names no window, so both ids are -1.
 */
export function listBrowserExtensionSidePanelContexts(
  profileId: string,
  extensionId: string,
  filter: ContextFilter
): SidePanelContext[] {
  return listBrowserExtensionSidePanelGuests(profileId, extensionId).flatMap(({ guest }) => {
    const frame = guest.mainFrame
    const documentUrl = guest.getURL()
    if (!documentUrl.startsWith('chrome-extension:')) {
      return []
    }
    const documentId = getBrowserExtensionDocumentId(frame)
    const context: SidePanelContext = {
      contextId: documentId,
      contextType: 'SIDE_PANEL',
      documentId,
      // Why the frame's: Node's URL gives "null" as the origin of a chrome-extension: URL.
      documentOrigin: frame.origin,
      documentUrl,
      frameId: 0,
      incognito: false,
      tabId: -1,
      windowId: -1
    }
    return matches(filter.contextIds, context.contextId) &&
      matches(filter.contextTypes, context.contextType) &&
      matches(filter.documentIds, context.documentId) &&
      matches(filter.documentOrigins, context.documentOrigin) &&
      matches(filter.documentUrls, context.documentUrl) &&
      matches(filter.frameIds, context.frameId) &&
      (filter.incognito === undefined || filter.incognito === context.incognito) &&
      matches(filter.tabIds, context.tabId) &&
      matches(filter.windowIds, context.windowId)
      ? [context]
      : []
  })
}
