import type { BrowserNetworkEntry } from '../../shared/runtime-types'

// Why one cap for every debugger-collected network log: entries accumulate for the
// whole capture, so an unbounded log pins every response URL until capture stops.
export const NETWORK_LOG_ENTRY_LIMIT = 1000

export type NetworkLogRecordTarget = {
  networkLog: BrowserNetworkEntry[]
  networkRequestMap: Map<string, BrowserNetworkEntry>
}

export type NetworkResponseOverrides = {
  url?: string
  method?: string
  timestamp?: number
}

export function recordNetworkResponseReceived(
  target: NetworkLogRecordTarget,
  params: unknown,
  overrides?: NetworkResponseOverrides
): boolean {
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
  if (!p?.response) {
    return false
  }
  const entry: BrowserNetworkEntry = {
    url: overrides?.url ?? p.response.url ?? '',
    method: overrides?.method ?? '',
    status: p.response.status ?? 0,
    mimeType: p.response.mimeType ?? '',
    size: 0,
    timestamp: overrides?.timestamp ?? p.timestamp ?? Date.now()
  }
  target.networkLog.push(entry)
  // Why: map requestId→entry so loadingFinished attributes size to the right response, not the latest one.
  if (p.requestId) {
    target.networkRequestMap.set(p.requestId, entry)
  }
  if (target.networkLog.length <= NETWORK_LOG_ENTRY_LIMIT) {
    return false
  }
  const evicted = target.networkLog.shift()
  if (evicted) {
    for (const [requestId, requestEntry] of target.networkRequestMap) {
      if (requestEntry === evicted) {
        target.networkRequestMap.delete(requestId)
        break
      }
    }
  }
  return true
}

export function finishNetworkRequest(
  target: NetworkLogRecordTarget,
  method: string,
  params: unknown
): void {
  const p = params as { requestId?: string; encodedDataLength?: number } | undefined
  if (p?.requestId) {
    const entry = target.networkRequestMap.get(p.requestId)
    if (entry && method === 'Network.loadingFinished' && p.encodedDataLength) {
      entry.size = p.encodedDataLength
    }
    target.networkRequestMap.delete(p.requestId)
  }
}
