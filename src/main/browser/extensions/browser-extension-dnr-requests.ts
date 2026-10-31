import type { BrowserSessionRequestDecider } from '../browser-session-request-decisions'
import {
  createDnrRequestState,
  type DnrEvaluateOptions,
  type DnrRequestState
} from './declarative-net-request/engine'
import {
  applyDnrRequestHeaderActions,
  applyDnrResponseHeaderActions
} from './declarative-net-request/header-modification'
import type { DnrRequestInfo, DnrResponseHeaders } from './declarative-net-request/request-context'
import type { DnrRequestAction } from './declarative-net-request/ruleset-matcher'
import { getDnrSessionRuntime, type DnrSessionRuntime } from './browser-extension-dnr-session'
import { extensionHasPermission } from './browser-extension-namespace-registry'
import { chromeResourceType, isRequestHiddenFromExtensions } from './browser-extension-web-request'

type RequestDetails = {
  id: number
  url: string
  method: string
  resourceType: string
  webContentsId?: number
  frame?: Electron.WebFrameMain | null
  initiatorOrigin?: string
}

function requestInfo(runtime: DnrSessionRuntime, details: RequestDetails): DnrRequestInfo {
  const type = chromeResourceType(details.resourceType)
  const { webContentsId } = details
  return {
    url: details.url,
    method: details.method,
    type,
    initiator: details.initiatorOrigin ?? null,
    tabId: runtime.frames.tabIdFor(webContentsId),
    topFrameOrigin:
      type === 'main_frame' || webContentsId === undefined
        ? null
        : runtime.frames.topOrigin(webContentsId)
  }
}

function evaluateOptions(
  runtime: DnrSessionRuntime,
  details: RequestDetails,
  info: DnrRequestInfo
): DnrEvaluateOptions {
  // A sub_frame load inherits from the frame that embeds it; Electron names the child frame.
  let frameAllow: DnrEvaluateOptions['frameAllow']
  if (info.type !== 'main_frame' && runtime.frames.hasAllowStates()) {
    const frame = details.frame && !details.frame.isDestroyed() ? details.frame : null
    const owner = info.type === 'sub_frame' ? frame?.parent : frame
    frameAllow = owner ? runtime.frames.allowFor(owner.frameTreeNodeId) : undefined
  }
  return {
    frameAllow,
    hostAccess: (extensionId) =>
      runtime.extensions
        .get(extensionId)
        ?.hostAccess.access(info.url, info.initiator, info.tabId, info.type) ?? 'denied'
  }
}

/** Chrome matches a committed document with its navigation's method and response headers. */
function noteNavigation(
  runtime: DnrSessionRuntime,
  details: RequestDetails,
  info: DnrRequestInfo,
  responseHeaders?: DnrResponseHeaders
): void {
  const frame = details.frame && !details.frame.isDestroyed() ? details.frame : null
  const navigates = info.type === 'main_frame' || info.type === 'sub_frame'
  if (navigates && frame && details.webContentsId !== undefined) {
    runtime.frames.noteNavigation(details.webContentsId, frame.frameTreeNodeId, {
      url: info.url,
      isPost: info.method.toUpperCase() === 'POST',
      responseHeaders
    })
  }
}

// Why a set: one action can apply at both header stages, and Chrome counts it once.
const recordedActions = new WeakSet<DnrRequestAction>()

function recordMatch(
  runtime: DnrSessionRuntime,
  action: DnrRequestAction,
  info: DnrRequestInfo,
  requestId: number
): void {
  if (!recordedActions.has(action)) {
    recordedActions.add(action)
    runtime.matched.record(action, info.tabId, info.type === 'main_frame' ? requestId : null)
  }
}

function hasAllow(state: DnrRequestState): boolean {
  for (const action of state.allowByExtension.values()) {
    if (action !== null) {
      return true
    }
  }
  return false
}

function decideBeforeRequest(
  runtime: DnrSessionRuntime,
  details: Electron.OnBeforeRequestListenerDetails
): Electron.CallbackResponse | null {
  if (!runtime.evaluatesRequests && !runtime.evaluatesResponses) {
    return null
  }
  const info = requestInfo(runtime, details)
  noteNavigation(runtime, details, info)
  const state = createDnrRequestState()
  const { actions } = runtime.engine.evaluateBeforeRequest(
    info,
    state,
    evaluateOptions(runtime, details, info)
  )
  // Header actions, and allows that outrank response-stage rules, carry over to later stages.
  if (
    state.actions.some((action) => action.type === 'modifyHeaders') ||
    (runtime.evaluatesResponses && hasAllow(state))
  ) {
    runtime.keepRequestState(details.id, state)
  } else {
    runtime.takeRequestState(details.id)
  }
  const action = actions.at(0)
  switch (action?.type) {
    case 'block':
    case 'collapse':
      recordMatch(runtime, action, info, details.id)
      runtime.matched.finishNavigation(info.tabId, details.id)
      return { cancel: true }
    case 'redirect':
    case 'upgradeScheme':
      recordMatch(runtime, action, info, details.id)
      return action.redirectUrl ? { redirectURL: action.redirectUrl } : null
    case 'allow':
    case 'allowAllRequests':
      recordMatch(runtime, action, info, details.id)
      return null
    case 'modifyHeaders':
    case undefined:
      return null
  }
}

function discardUnauthorizedActions(
  runtime: DnrSessionRuntime,
  state: DnrRequestState,
  info: DnrRequestInfo
): void {
  const allowed = new Map<string, boolean>()
  for (const extensionId of new Set([
    ...state.allowByExtension.keys(),
    ...state.actions.map((action) => action.rule.extensionId)
  ])) {
    const entry = runtime.extensions.get(extensionId)
    const hasHostAccess =
      entry?.hostAccess.access(info.url, info.initiator, info.tabId, info.type) === 'allowed'
    allowed.set(extensionId, hasHostAccess)
    if (
      !entry ||
      (!hasHostAccess &&
        !extensionHasPermission(entry.rules.extension, 'declarativeNetRequest', runtime.session))
    ) {
      state.allowByExtension.delete(extensionId)
    }
  }
  state.actions = state.actions.filter((action) => allowed.get(action.rule.extensionId) === true)
}

function decideRequestHeaders(
  runtime: DnrSessionRuntime,
  details: Electron.OnBeforeSendHeadersListenerDetails,
  headers: Record<string, string>
): Record<string, string> {
  const state = runtime.evaluatesResponses
    ? runtime.requestState(details.id)
    : runtime.takeRequestState(details.id)
  const info = requestInfo(runtime, details)
  if (state) {
    discardUnauthorizedActions(runtime, state, info)
  }
  if (!state?.actions.some((action) => action.requestHeaders?.length)) {
    return headers
  }
  const modified = applyDnrRequestHeaderActions(headers, state.actions)
  for (const action of modified.appliedActions) {
    recordMatch(runtime, action, info, details.id)
  }
  return modified.headers
}

function decideHeadersReceived(
  runtime: DnrSessionRuntime,
  details: Electron.OnHeadersReceivedListenerDetails
): Electron.HeadersReceivedResponse | null {
  const stored = runtime.takeRequestState(details.id)
  const responseHeaders = details.responseHeaders ?? {}
  const info = requestInfo(runtime, details)
  noteNavigation(runtime, details, info, responseHeaders)
  const state = stored ?? createDnrRequestState()
  discardUnauthorizedActions(runtime, state, info)
  if (runtime.evaluatesResponseConditions) {
    const evaluation = runtime.engine.evaluateHeadersReceived(
      info,
      responseHeaders,
      state,
      evaluateOptions(runtime, details, info)
    )
    const action = evaluation.actions.at(0)
    switch (action?.type) {
      case 'block':
      case 'collapse':
        recordMatch(runtime, action, info, details.id)
        runtime.matched.finishNavigation(info.tabId, details.id)
        return { cancel: true }
      case 'redirect':
      case 'upgradeScheme': {
        recordMatch(runtime, action, info, details.id)
        if (!action.redirectUrl) {
          return null
        }
        // RedirectRequestAfterHeadersReceived: the response becomes a 302 to the new URL.
        const headers = Object.fromEntries(
          Object.entries(responseHeaders).filter(([name]) => name.toLowerCase() !== 'location')
        )
        return {
          statusLine: 'HTTP/1.1 302 Found',
          responseHeaders: { ...headers, Location: [action.redirectUrl] }
        }
      }
      case 'allow':
      case 'allowAllRequests':
        if (evaluation.reportAllowMatch) {
          recordMatch(runtime, action, info, details.id)
        }
        break
      case 'modifyHeaders':
      case undefined:
        break
    }
  }
  if (!state.actions.some((action) => action.responseHeaders?.length)) {
    return null
  }
  const modified = applyDnrResponseHeaderActions(responseHeaders, state.actions)
  if (modified.appliedActions.length === 0) {
    return null
  }
  for (const action of modified.appliedActions) {
    recordMatch(runtime, action, info, details.id)
  }
  return { responseHeaders: modified.headers }
}

/** declarativeNetRequest inside Orca's session handlers; one WeakMap lookup when unused. */
export const browserExtensionDnrRequestDecider: BrowserSessionRequestDecider = {
  beforeRequest: (session, details) => {
    const runtime = getDnrSessionRuntime(session)
    if (!runtime?.inUse || isRequestHiddenFromExtensions(details)) {
      return null
    }
    const loading = runtime.whenLoaded()
    return loading
      ? loading.then(() => decideBeforeRequest(runtime, details) ?? {})
      : decideBeforeRequest(runtime, details)
  },
  beforeSendHeaders: (session, details, headers) => {
    const runtime = getDnrSessionRuntime(session)
    return runtime?.inUse && !isRequestHiddenFromExtensions(details)
      ? decideRequestHeaders(runtime, details, headers)
      : headers
  },
  headersReceived: (session, details) => {
    const runtime = getDnrSessionRuntime(session)
    return runtime?.evaluatesResponses && !isRequestHiddenFromExtensions(details)
      ? decideHeadersReceived(runtime, details)
      : null
  },
  requestFinished: (session, event, details) => {
    const runtime = getDnrSessionRuntime(session)
    if (!runtime) {
      return
    }
    runtime.takeRequestState(details.id)
    if (event === 'onErrorOccurred' && details.resourceType === 'mainFrame') {
      runtime.matched.finishNavigation(runtime.frames.tabIdFor(details.webContentsId), details.id)
    }
  },
  requestLifecycleStopped: (session) => {
    getDnrSessionRuntime(session)?.clearPendingRequests()
  }
}
