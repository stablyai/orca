export type PairingConnectionAttempt = {
  readonly timedOut: boolean
  dispose: () => void
}

/** Overall pair budget shared by pair-scan / pair-confirm (KTD4). */
export const PAIRING_OVERALL_TIMEOUT_MS = 25_000
/** Steady-state reconnect keeps 12s; pair-time uses a shorter per-endpoint budget (KTD4). */
export const PAIR_CONNECT_TIMEOUT_MS = 3_500
/** Includes WebSocket open and pinned E2EE authentication for one ordered route. */
export const PAIR_ROUTE_AUTH_TIMEOUT_MS = 4_500
/** Cap pair-time walk so n×timeout + handshake margin fits PAIRING_OVERALL_TIMEOUT (~25s). */
export const PAIR_MAX_DIAL_ENDPOINTS = 4
/** Leave room for E2EE + status.get after the last dial opens. */
export const PAIR_POST_DIAL_MARGIN_MS = 7_000

export type PairDialPlan = {
  endpoints: string[]
  connectTimeoutMs: number
}

/**
 * Bound the pair-time endpoint walk: explore ≤4, shrink per-endpoint timeout when needed
 * so n×timeout + margin ≤ overall pair budget (KTD4).
 */
export function resolvePairDialPlan(
  endpoints: readonly string[],
  overallTimeoutMs: number = PAIRING_OVERALL_TIMEOUT_MS
): PairDialPlan {
  const capped = endpoints
    .map((ep) => ep.trim())
    .filter(Boolean)
    .slice(0, PAIR_MAX_DIAL_ENDPOINTS)
  const n = Math.max(1, capped.length)
  const budgetForDials = Math.max(1_000, overallTimeoutMs - PAIR_POST_DIAL_MARGIN_MS)
  const maxPerEndpoint = Math.floor(budgetForDials / n)
  const connectTimeoutMs = Math.min(PAIR_CONNECT_TIMEOUT_MS, maxPerEndpoint)
  return {
    endpoints: capped.length > 0 ? capped : [],
    connectTimeoutMs: Math.max(1_000, connectTimeoutMs)
  }
}

/** Share one absolute deadline across all ordered routes and post-win persistence. */
export function resolvePairRouteAuthTimeout(
  routeCount: number,
  deadlineAt: number,
  now: number = Date.now()
): number {
  const count = Math.max(1, routeCount)
  const routeBudget = Math.max(1, deadlineAt - now - PAIR_POST_DIAL_MARGIN_MS)
  return Math.max(1, Math.min(PAIR_ROUTE_AUTH_TIMEOUT_MS, Math.floor(routeBudget / count)))
}

export function startPairingConnectionAttempt({
  timeoutMs,
  closeClient
}: {
  timeoutMs: number
  closeClient: () => void
}): PairingConnectionAttempt {
  let disposed = false
  let clientClosed = false
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function closeClientOnce() {
    if (clientClosed) {
      return
    }
    clientClosed = true
    closeClient()
  }

  function dispose() {
    if (disposed) {
      return
    }
    disposed = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    closeClientOnce()
  }

  timer = setTimeout(() => {
    timer = null
    timedOut = true
    dispose()
  }, timeoutMs)

  return {
    get timedOut() {
      return timedOut
    },
    dispose
  }
}
