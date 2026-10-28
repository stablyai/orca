/// <reference types="chrome" />
import { webFrameMain } from 'electron'
import { z } from 'zod'
import { emitBrowserExtensionEvent } from '../browser-extension-api-host'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  extensionHasPermission,
  registerBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../browser-extension-namespace-registry'
import {
  forgetBrowserExtensionDocuments,
  getBrowserExtensionDocumentId,
  startBrowserExtensionDocument
} from '../browser-extension-document-ids'
import {
  listBrowserExtensionTabs,
  resolveBrowserExtensionTab
} from '../browser-extension-tab-model'

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
    ...(withDocument ? { documentId: getBrowserExtensionDocumentId(frame.frameTreeNodeId) } : {}),
    ...(frame.parent
      ? { parentDocumentId: getBrowserExtensionDocumentId(frame.parent.frameTreeNodeId) }
      : {}),
    frameType: frame.parent ? ('sub_frame' as const) : ('outermost_frame' as const),
    documentLifecycle: 'active' as const
  }
}

function frameDetails(
  tabId: number,
  frame: Electron.WebFrameMain,
  url = frame.url,
  withDocument = true
) {
  return {
    tabId,
    url,
    processId: frame.processId,
    ...chromeFrameDocument(frame, withDocument),
    timeStamp: Date.now()
  }
}

type CreatedNavigationTargetDetails = {
  sourceTabId: number
  sourceProcessId: number
  sourceFrameId: number
  url: string
  tabId: number
  timeStamp: number
}

type FrameEventDetails = ReturnType<typeof frameDetails> & {
  transitionType?: string
  transitionQualifiers?: string[]
  error?: string
}

type NavigationEventDetails = FrameEventDetails | CreatedNavigationTargetDetails

function emitNavigation(
  contents: Electron.WebContents,
  event: string,
  details: NavigationEventDetails
): void {
  emitBrowserExtensionEvent({ session: contents.session }, 'webNavigation', event, [details])
}

const getFrameSchema = z
  .object({
    tabId: z.number().int(),
    frameId: z.number().int(),
    processId: z.number().int(),
    documentId: z.string()
  })
  .partial()
  .loose()
const getAllFramesSchema = z.object({ tabId: z.number().int() }).loose()

// Preload-only (see browser-extension-document-targets.ts): Orca's ids for native scripting targets.
const DOCUMENT_TARGETS_NAMESPACE = 'orcaDocumentTargets'

function tabFrames(caller: BrowserExtensionCaller, tabId: number): Electron.WebFrameMain[] | null {
  const entry = resolveBrowserExtensionTab(tabId)
  if (!entry || entry.contents.session !== caller.session) {
    return null
  }
  return entry.contents.mainFrame.framesInSubtree
}

/** getFrame takes a tab and frame id, or (Chrome 106+) a documentId alone. */
function findFrame(
  caller: BrowserExtensionCaller,
  details: z.infer<typeof getFrameSchema>
): Electron.WebFrameMain | null {
  const { tabId, frameId, documentId } = details
  if (documentId === undefined && (tabId === undefined || frameId === undefined)) {
    throw new BrowserExtensionApiError('Either documentId or both tabId and frameId must be given')
  }
  const frames =
    tabId === undefined
      ? listBrowserExtensionTabs(caller.session).flatMap(
          (entry) => entry.contents.mainFrame.framesInSubtree
        )
      : (tabFrames(caller, tabId) ?? [])
  // Why the frame-tree id too: Electron's native sender gives an unloading outermost frame that id
  // (documentLifecycle 'pending_deletion'); Orca names every outermost frame 0.
  return (
    frames.find(
      (frame) =>
        (frameId === undefined ||
          chromeFrameId(frame) === frameId ||
          (!frame.parent && frame.frameTreeNodeId === frameId)) &&
        (documentId === undefined ||
          getBrowserExtensionDocumentId(frame.frameTreeNodeId) === documentId)
    ) ?? null
  )
}

function describeFrame(frame: Electron.WebFrameMain) {
  return { errorOccurred: false, url: frame.url, ...chromeFrameDocument(frame, true) }
}

export function registerWebNavigationNamespace(): void {
  registerBrowserExtensionNamespace('webNavigation', {
    permission: 'webNavigation',
    methods: {
      getFrame: defineBrowserExtensionMethod(z.tuple([getFrameSchema]), (caller, details) => {
        const frame = findFrame(caller, details)
        return frame ? describeFrame(frame) : null
      }),
      getAllFrames: defineBrowserExtensionMethod(
        z.tuple([getAllFramesSchema]),
        (caller, details) =>
          tabFrames(caller, details.tabId)?.map((frame) => ({
            ...describeFrame(frame),
            processId: frame.processId
          })) ?? null
      )
    },
    events: [
      'onBeforeNavigate',
      'onCommitted',
      'onDOMContentLoaded',
      'onCompleted',
      'onErrorOccurred',
      'onHistoryStateUpdated',
      'onReferenceFragmentUpdated',
      'onCreatedNavigationTarget'
    ]
  })
  registerBrowserExtensionNamespace(DOCUMENT_TARGETS_NAMESPACE, {
    methods: {
      // Only extensions that can learn Orca's ids (webNavigation, webRequest) need them mapped.
      frames: defineBrowserExtensionMethod(z.tuple([z.number().int()]), (caller, tabId) =>
        ['webNavigation', 'webRequest'].some((permission) =>
          extensionHasPermission(caller.extension, permission, caller.session)
        )
          ? (tabFrames(caller, tabId) ?? []).map((frame) => ({
              frameId: chromeFrameId(frame),
              documentId: getBrowserExtensionDocumentId(frame.frameTreeNodeId)
            }))
          : []
      )
    },
    events: []
  })
}

function withoutHash(url: string): string {
  const index = url.indexOf('#')
  return index === -1 ? url : url.slice(0, index)
}

/** Translates one webContents' navigation events (main frame and subframes) into webNavigation. */
export function observeBrowserExtensionWebNavigation(contents: Electron.WebContents): void {
  const tabId = contents.id
  const committedUrlByFrame = new Map<number, string>()
  const frameTreeNodeIds = new Set([contents.mainFrame.frameTreeNodeId])
  contents.once('destroyed', () => forgetBrowserExtensionDocuments(frameTreeNodeIds))
  const lookup = (processId: number, routingId: number): Electron.WebFrameMain | null => {
    const frame = webFrameMain.fromId(processId, routingId)
    return frame && !frame.isDestroyed() ? frame : null
  }
  contents.on('did-start-navigation', ({ url, isSameDocument, frame }) => {
    if (!isSameDocument && frame && !frame.isDestroyed()) {
      emitNavigation(contents, 'onBeforeNavigate', frameDetails(tabId, frame, url, false))
    }
  })
  contents.on(
    'did-frame-navigate',
    (_event, url, _code, _status, _isMain, processId, routingId) => {
      const frame = lookup(processId, routingId)
      if (frame) {
        frameTreeNodeIds.add(frame.frameTreeNodeId)
        startBrowserExtensionDocument(frame.frameTreeNodeId)
        committedUrlByFrame.set(frame.frameTreeNodeId, url)
        emitNavigation(contents, 'onCommitted', {
          ...frameDetails(tabId, frame, url),
          transitionType: 'link',
          transitionQualifiers: []
        })
      }
    }
  )
  contents.on('did-navigate-in-page', (_event, url, _isMain, processId, routingId) => {
    const frame = lookup(processId, routingId)
    if (!frame) {
      return
    }
    const previous = committedUrlByFrame.get(frame.frameTreeNodeId)
    committedUrlByFrame.set(frame.frameTreeNodeId, url)
    const fragmentOnly = previous !== undefined && withoutHash(previous) === withoutHash(url)
    emitNavigation(
      contents,
      fragmentOnly ? 'onReferenceFragmentUpdated' : 'onHistoryStateUpdated',
      {
        ...frameDetails(tabId, frame, url),
        transitionType: 'link',
        transitionQualifiers: []
      }
    )
  })
  const emitDomContentLoaded = (frame: Electron.WebFrameMain): void => {
    if (!frame.isDestroyed()) {
      emitNavigation(contents, 'onDOMContentLoaded', frameDetails(tabId, frame))
    }
  }
  contents.on('dom-ready', () => emitDomContentLoaded(contents.mainFrame))
  // Why subframes only: frame-created also fires for the main frame, whose dom-ready is above.
  contents.on('frame-created', (_event, { frame }) => {
    if (frame?.parent) {
      frameTreeNodeIds.add(frame.frameTreeNodeId)
      frame.on('dom-ready', () => emitDomContentLoaded(frame))
    }
  })
  contents.on('did-frame-finish-load', (_event, _isMain, processId, routingId) => {
    const frame = lookup(processId, routingId)
    if (frame) {
      emitNavigation(contents, 'onCompleted', frameDetails(tabId, frame))
    }
  })
  contents.on('did-fail-load', (_event, _code, description, url, _isMain, processId, routingId) => {
    const frame = lookup(processId, routingId)
    if (frame) {
      emitNavigation(contents, 'onErrorOccurred', {
        ...frameDetails(tabId, frame, url),
        error: description.startsWith('net::') ? description : `net::${description}`
      })
    }
  })
  contents.on('did-create-window', (window, details) => {
    emitNavigation(contents, 'onCreatedNavigationTarget', {
      sourceTabId: tabId,
      sourceProcessId: contents.mainFrame.processId,
      sourceFrameId: 0,
      url: details.url,
      tabId: window.webContents.id,
      timeStamp: Date.now()
    })
  })
}
