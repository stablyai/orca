import { CHROME_WEB_STORE_ORIGIN } from '../../../shared/browser-extension-webstore'
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
import type { DnrRequestInfo } from './declarative-net-request/request-context'
import type { DnrRequestAction } from './declarative-net-request/ruleset-matcher'
import { getDnrSessionRuntime, type DnrSessionRuntime } from './browser-extension-dnr-session'
import { chromeResourceType } from './browser-extension-web-request'

type RequestDetails = {
  id: number
  url: string
  method: string
  resourceType: string
  webContentsId?: number
  frame?: Electron.WebFrameMain | null
  initiatorOrigin?: string
}

const WEB_URL = /^(?:https?|wss?):/i

/** WebRequestPermissions::HideRequest: requests extensions never see or act on. */
function isActionable(details: RequestDetails): boolean {
  if (!WEB_URL.test(details.url)) {
    return false
  }
  // Orca's own main-process requests carry neither a webContents nor an initiator.
  if (details.webContentsId === undefined && details.initiatorOrigin === undefined) {
    return false
  }
  return !(
    details.url.startsWith(`${CHROME_WEB_STORE_ORIGIN}/`) ||
    details.url.startsWith('https://chrome.google.com/webstore')
  )
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
        ?.hostAccess.access(info.url, info.initiator, info.tabId) ?? 'denied'
  }
}

// Why a set: one action can apply at both header stages, and Chrome counts it once.
const recordedActions = new WeakSet<DnrRequestAction>()

function recordMatch(
  runtime: DnrSessionRuntime,
  action: DnrRequestAction,
  info: DnrRequestInfo
): void {
  if (!recordedActions.has(action)) {
    recordedActions.add(action)
    runtime.matched.record(action, info.tabId, info.type === 'main_frame')
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
      recordMatch(runtime, action, info)
      return { cancel: true }
    case 'redirect':
    case 'upgradeScheme':
      recordMatch(runtime, action, info)
      return action.redirectUrl ? { redirectURL: action.redirectUrl } : null
    case 'allow':
    case 'allowAllRequests':
      recordMatch(runtime, action, info)
      return null
    case 'modifyHeaders':
    case undefined:
      return null
  }
}

function decideRequestHeaders(
  runtime: DnrSessionRuntime,
  details: Electron.OnBeforeSendHeadersListenerDetails,
  headers: Record<string, string>
): Record<string, string> {
  const state = runtime.evaluatesResponses
    ? runtime.requestState(details.id)
    : runtime.takeRequestState(details.id)
  if (!state?.actions.some((action) => action.requestHeaders?.length)) {
    return headers
  }
  const modified = applyDnrRequestHeaderActions(headers, state.actions)
  const info = requestInfo(runtime, details)
  for (const action of modified.appliedActions) {
    recordMatch(runtime, action, info)
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
  const state = stored ?? createDnrRequestState()
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
        recordMatch(runtime, action, info)
        return { cancel: true }
      case 'redirect':
      case 'upgradeScheme': {
        recordMatch(runtime, action, info)
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
          recordMatch(runtime, action, info)
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
    recordMatch(runtime, action, info)
  }
  return { responseHeaders: modified.headers }
}

/** declarativeNetRequest inside Orca's session handlers; one WeakMap lookup when unused. */
export const browserExtensionDnrRequestDecider: BrowserSessionRequestDecider = {
  beforeRequest: (session, details) => {
    const runtime = getDnrSessionRuntime(session)
    if (!runtime?.inUse || !isActionable(details)) {
      return null
    }
    const loading = runtime.whenLoaded()
    return loading
      ? loading.then(() => decideBeforeRequest(runtime, details) ?? {})
      : decideBeforeRequest(runtime, details)
  },
  beforeSendHeaders: (session, details, headers) => {
    const runtime = getDnrSessionRuntime(session)
    return runtime?.inUse && isActionable(details)
      ? decideRequestHeaders(runtime, details, headers)
      : headers
  },
  headersReceived: (session, details) => {
    const runtime = getDnrSessionRuntime(session)
    return runtime?.evaluatesResponses && isActionable(details)
      ? decideHeadersReceived(runtime, details)
      : null
  }
}
