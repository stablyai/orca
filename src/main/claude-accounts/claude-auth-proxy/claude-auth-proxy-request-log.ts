import type { ClaudeAuthProxyStatus } from '../../../shared/claude-auth-proxy-status'

const REQUEST_WINDOW_MS = 60 * 60 * 1000

type LoggedRequest = { accountId: string; at: number }

export function createClaudeAuthProxyRequestLog(
  now: () => number,
  log: (line: string) => void
): {
  observe: (
    method: string,
    upstreamPath: string,
    status: number,
    accountId: string | null,
    unknownSlot: boolean
  ) => void
  snapshot: () => Pick<
    ClaudeAuthProxyStatus,
    'requestsLastHour' | 'unknownSlotRequests' | 'lastError'
  >
} {
  const requests: LoggedRequest[] = []
  let unknownSlotRequests = 0
  let lastError: ClaudeAuthProxyStatus['lastError'] = null

  function prune(at: number): void {
    const cutoff = at - REQUEST_WINDOW_MS
    let drop = 0
    while (drop < requests.length && requests[drop]!.at < cutoff) {
      drop += 1
    }
    if (drop > 0) {
      requests.splice(0, drop)
    }
  }

  return {
    observe(method, upstreamPath, status, accountId, unknownSlot) {
      const at = now()
      log(`${method} ${upstreamPath} ${status} ${accountId ?? '-'}`)
      if (accountId) {
        requests.push({ accountId, at })
        prune(at)
      }
      if (unknownSlot) {
        unknownSlotRequests += 1
      }
      if (status >= 400) {
        lastError = { at, method, path: upstreamPath, status, accountId }
      }
    },
    snapshot() {
      const at = now()
      prune(at)
      const counts = new Map<string, number>()
      for (const request of requests) {
        counts.set(request.accountId, (counts.get(request.accountId) ?? 0) + 1)
      }
      const requestsLastHour = [...counts.entries()]
        .map(([accountId, count]) => ({ accountId, count }))
        .sort((left, right) =>
          left.accountId < right.accountId ? -1 : left.accountId > right.accountId ? 1 : 0
        )
      return { requestsLastHour, unknownSlotRequests, lastError }
    }
  }
}
