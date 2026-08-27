// Why: for long-poll methods the caller's method-level
// `params.timeoutMs` is the inner waiter budget; we extend the client-side
// socket timeout to `timeoutMs + GRACE_MS` so the client's own idle timer
// never fires before the server-side waiter has had a chance to resolve and
// emit its terminal frame. The 10 s grace absorbs round-trip + one final
// keepalive window. See design doc §3.1.
export const LONG_POLL_CLIENT_GRACE_MS = 10_000

// Why: the collaboration server's own wait budget for a waiting checkpoint
// poll. A client configured below this would otherwise time out before the
// server resolves, so the default effective client timeout is budget + grace.
export const COLLABORATION_CHECKPOINT_WAIT_BUDGET_MS = 60_000
const WORKER_START_READINESS_WAIT_BUDGET_MS = 60_000

export function isWaitingCheck(params: unknown): boolean {
  return (
    typeof params === 'object' &&
    params !== null &&
    'wait' in params &&
    (params as { wait: unknown }).wait === true
  )
}

export function isWaitingCollaborationCheckpoint(method: string, params: unknown): boolean {
  return method === 'orchestration.collaborationCheckpoint' && isWaitingCheck(params)
}

export function getTimeoutMsParam(params: unknown): unknown {
  if (typeof params !== 'object' || params === null || !('timeoutMs' in params)) {
    return undefined
  }
  return (params as { timeoutMs?: unknown }).timeoutMs
}

export function resolveMethodTimeoutMs(
  method: string,
  params: unknown,
  requestTimeoutMs: number
): number {
  if (isWaitingCollaborationCheckpoint(method, params)) {
    const inner = Number(getTimeoutMsParam(params))
    if (Number.isFinite(inner) && inner > 0) {
      return Math.max(inner + LONG_POLL_CLIENT_GRACE_MS, requestTimeoutMs)
    }
    return Math.max(
      COLLABORATION_CHECKPOINT_WAIT_BUDGET_MS + LONG_POLL_CLIENT_GRACE_MS,
      requestTimeoutMs
    )
  }
  if (method === 'orchestration.workerStart') {
    const inner = Number(getTimeoutMsParam(params))
    const readinessBudget =
      Number.isFinite(inner) && inner > 0 ? inner : WORKER_START_READINESS_WAIT_BUDGET_MS
    return Math.max(readinessBudget + LONG_POLL_CLIENT_GRACE_MS, requestTimeoutMs)
  }
  if ((method === 'orchestration.check' && isWaitingCheck(params)) || method === 'terminal.wait') {
    const inner = Number(getTimeoutMsParam(params))
    if (Number.isFinite(inner) && inner > 0) {
      return Math.max(inner + LONG_POLL_CLIENT_GRACE_MS, requestTimeoutMs)
    }
  }
  return requestTimeoutMs
}
