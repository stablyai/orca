import { resolveOrchestrationAgentReadinessTimeoutMs } from '../../shared/orchestration-dispatch-readiness'

const LONG_POLL_CLIENT_GRACE_MS = 10_000

export function resolveRuntimeClientTimeoutMs(
  method: string,
  params: unknown,
  defaultTimeoutMs: number
): number {
  const readinessTimeoutMs = resolveOrchestrationAgentReadinessTimeoutMs(method, params)
  if (readinessTimeoutMs !== null) {
    return Math.max(readinessTimeoutMs + LONG_POLL_CLIENT_GRACE_MS, defaultTimeoutMs)
  }
  if ((method === 'orchestration.check' && isWaitingCheck(params)) || method === 'terminal.wait') {
    const inner = Number(getTimeoutMsParam(params))
    if (Number.isFinite(inner) && inner > 0) {
      return Math.max(inner + LONG_POLL_CLIENT_GRACE_MS, defaultTimeoutMs)
    }
  }
  return defaultTimeoutMs
}

function isWaitingCheck(params: unknown): boolean {
  return (
    typeof params === 'object' &&
    params !== null &&
    'wait' in params &&
    (params as { wait: unknown }).wait === true
  )
}

function getTimeoutMsParam(params: unknown): unknown {
  if (typeof params !== 'object' || params === null || !('timeoutMs' in params)) {
    return undefined
  }
  return (params as { timeoutMs?: unknown }).timeoutMs
}
