import type { WebContents } from 'electron'
import type { BrowserNetworkEntry } from '../../shared/runtime-types'
import type { CdpTabState } from './cdp-auxiliary-commands'

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
        guest.debugger.sendCommand('DOM.enable', {}, p.sessionId).catch(() => {})
        guest.debugger.sendCommand('Accessibility.enable', {}, p.sessionId).catch(() => {})
        guest.debugger.sendCommand('Runtime.enable', {}, p.sessionId).catch(() => {})
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
        const p = params as
          | {
              requestId?: string
              response?: {
                url?: string
                status?: number
                mimeType?: string
                headers?: Record<string, string>
              }
              type?: string
              timestamp?: number
            }
          | undefined
        if (p?.response) {
          const entry: BrowserNetworkEntry = {
            url: p.response.url ?? '',
            method: '',
            status: p.response.status ?? 0,
            mimeType: p.response.mimeType ?? '',
            size: 0,
            timestamp: p.timestamp ?? Date.now()
          }
          state.networkLog.push(entry)
          // Why: map requestId→entry so loadingFinished attributes size to the right response, not the latest one.
          if (p.requestId) {
            state.networkRequestMap.set(p.requestId, entry)
          }
          if (state.networkLog.length > CAPTURE_LOG_LIMIT) {
            const evicted = state.networkLog.shift()
            if (evicted) {
              for (const [requestId, requestEntry] of state.networkRequestMap) {
                if (requestEntry === evicted) {
                  state.networkRequestMap.delete(requestId)
                  break
                }
              }
            }
          }
        }
      }
      if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        const p = params as { requestId?: string; encodedDataLength?: number } | undefined
        if (p?.requestId) {
          const entry = state.networkRequestMap.get(p.requestId)
          if (entry && method === 'Network.loadingFinished' && p.encodedDataLength) {
            entry.size = p.encodedDataLength
          }
          state.networkRequestMap.delete(p.requestId)
        }
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
