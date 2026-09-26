import type { WebContents } from 'electron'
import type { CdpTabState } from './cdp-auxiliary-commands'
import { finishNetworkRequest, recordNetworkResponseReceived } from './cdp-network-log-recorder'

const CAPTURE_LOG_LIMIT = 1000

export function createCdpDebuggerMessageListener(
  guest: WebContents,
  state: CdpTabState
): (_event: unknown, method: string, params: unknown) => void {
  return (_event: unknown, method: string, params: unknown): void => {
    if (method === 'Page.frameNavigated') {
      state.snapshotResult = null
      state.navigationId = null
    }
    // Why: an unhandled JS dialog blocks all subsequent CDP commands; auto-dismiss to avoid hanging.
    if (method === 'Page.javascriptDialogOpening') {
      const dialog = params as { type: string; message: string } | undefined
      guest.debugger
        .sendCommand('Page.handleJavaScriptDialog', {
          accept: dialog?.type !== 'beforeunload'
        })
        .catch(() => {})
    }
    // Why: track iframe sessions so CDP commands and AX queries route to the correct session.
    if (method === 'Target.attachedToTarget') {
      const p = params as
        | {
            sessionId?: string
            targetInfo?: { type?: string; targetId?: string }
          }
        | undefined
      if (p?.sessionId && p.targetInfo?.type === 'iframe' && p.targetInfo.targetId) {
        state.iframeSessions.set(p.targetInfo.targetId, p.sessionId)
        // Why: no Runtime.enable here. Cross-origin iframes include challenge widgets
        // (Cloudflare Turnstile), and the Runtime domain's console/Error.stack serialization
        // is the CDP tell they detect; nothing reads iframe Runtime events anyway.
        guest.debugger.sendCommand('DOM.enable', {}, p.sessionId).catch(() => {})
        guest.debugger.sendCommand('Accessibility.enable', {}, p.sessionId).catch(() => {})
      }
    }
    if (method === 'Target.detachedFromTarget') {
      const p = params as { sessionId?: string } | undefined
      if (p?.sessionId) {
        for (const [frameId, sid] of state.iframeSessions) {
          if (sid === p.sessionId) {
            state.iframeSessions.delete(frameId)
            break
          }
        }
      }
    }
    // Why: buffer console/network events per-tab so the agent can retrieve them on demand.
    if (state.capturing) {
      if (method === 'Runtime.consoleAPICalled') {
        const p = params as
          | {
              type?: string
              args?: { value?: string; description?: string }[]
              timestamp?: number
              stackTrace?: { callFrames?: { url?: string; lineNumber?: number }[] }
            }
          | undefined
        if (p) {
          const text = (p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
          state.consoleLog.push({
            level: p.type ?? 'log',
            text,
            timestamp: p.timestamp ?? Date.now(),
            url: p.stackTrace?.callFrames?.[0]?.url,
            line: p.stackTrace?.callFrames?.[0]?.lineNumber
          })
          if (state.consoleLog.length > CAPTURE_LOG_LIMIT) {
            state.consoleLog.shift()
          }
        }
      }
      if (method === 'Network.responseReceived') {
        recordNetworkResponseReceived(state, params)
      }
      if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        finishNetworkRequest(state, method, params)
      }
    }
    // Why: buffer paused requests so the agent can later inspect and continue or block them.
    if (state.intercepting && method === 'Fetch.requestPaused') {
      const p = params as
        | {
            requestId?: string
            request?: { url?: string; method?: string; headers?: Record<string, string> }
            resourceType?: string
          }
        | undefined
      if (p?.requestId && p.request) {
        state.pausedRequests.set(p.requestId, {
          id: p.requestId,
          url: p.request.url ?? '',
          method: p.request.method ?? 'GET',
          headers: (p.request.headers ?? {}) as Record<string, string>,
          resourceType: p.resourceType ?? 'Other'
        })
      }
    }
  }
}
