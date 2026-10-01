import { webFrameMain, type WebContents, type WebFrameMain } from 'electron'
import { emitExtensionEvent, handleExtensionApi, type ExtensionCaller } from './extension-api-host'
import { numberArg, objectArg } from './extension-api-args'
import { extensionTabs } from './extension-tab-registry'

/** Chrome's extension frame id: 0 for the tab's main frame, else the frame tree node id. */
export function extensionFrameId(frame: WebFrameMain): number {
  return frame.parent ? frame.frameTreeNodeId : 0
}

function frameInfo(frame: WebFrameMain): Record<string, unknown> {
  return {
    frameId: extensionFrameId(frame),
    parentFrameId: frame.parent ? extensionFrameId(frame.parent) : -1,
    processId: frame.processId,
    url: frame.url,
    frameType: frame.parent ? 'sub_frame' : 'outermost_frame',
    documentLifecycle: 'active',
    errorOccurred: false
  }
}

function emit(tab: WebContents, event: string, frame: WebFrameMain | null | undefined, extra = {}) {
  if (!frame || frame.isDestroyed()) {
    return
  }
  const details = { tabId: tab.id, timeStamp: Date.now(), ...frameInfo(frame), ...extra }
  for (const extension of tab.session.extensions.getAllExtensions()) {
    // Why only these: chrome.webNavigation exists only for extensions that asked for it.
    const permissions: unknown = extension.manifest.permissions
    if (Array.isArray(permissions) && permissions.includes('webNavigation')) {
      emitExtensionEvent(tab.session, `webNavigation.${event}`, [details], extension.id)
    }
  }
}

/** Fires chrome.webNavigation events for a tab's frames. */
export function watchWebNavigation(tab: WebContents): void {
  const frame = (processId: number, routingId: number) =>
    webFrameMain.fromId(processId, routingId) ?? null
  tab.on('did-start-navigation', (details) => {
    if (!details.isSameDocument) {
      emit(tab, 'onBeforeNavigate', details.frame, { url: details.url })
    }
  })
  tab.on('did-frame-navigate', (_event, url, _code, _status, _isMain, processId, routingId) =>
    emit(tab, 'onCommitted', frame(processId, routingId), {
      url,
      transitionType: 'link',
      transitionQualifiers: []
    })
  )
  tab.on('dom-ready', () => emit(tab, 'onDOMContentLoaded', tab.mainFrame))
  tab.on('frame-created', (_event, details) => {
    const created = details.frame
    created?.on('dom-ready', () => emit(tab, 'onDOMContentLoaded', created))
  })
  tab.on('did-frame-finish-load', (_event, _isMain, processId, routingId) =>
    emit(tab, 'onCompleted', frame(processId, routingId))
  )
  tab.on('did-fail-load', (_event, code, description, url, _isMain, processId, routingId) => {
    // -3 is ERR_ABORTED: a navigation replaced by another, which Chrome does not report.
    if (code !== -3) {
      emit(tab, 'onErrorOccurred', frame(processId, routingId), { url, error: description })
    }
  })
  tab.on('did-navigate-in-page', (_event, url, _isMain, processId, routingId) =>
    emit(tab, 'onHistoryStateUpdated', frame(processId, routingId), {
      url,
      transitionType: 'link',
      transitionQualifiers: []
    })
  )
}

function framesOf(caller: ExtensionCaller, details: unknown): WebFrameMain[] {
  const tabId = numberArg(objectArg(details).tabId, 'tabId')
  const tab = extensionTabs(caller.session).find((each) => each.id === tabId)
  return tab ? tab.mainFrame.framesInSubtree : []
}

handleExtensionApi('webNavigation', {
  getFrame: (caller: ExtensionCaller, details: unknown) => {
    const frameId = numberArg(objectArg(details).frameId, 'frameId')
    const frame = framesOf(caller, details).find((each) => extensionFrameId(each) === frameId)
    return frame ? frameInfo(frame) : null
  },
  getAllFrames: (caller: ExtensionCaller, details: unknown) =>
    framesOf(caller, details).map(frameInfo)
})
