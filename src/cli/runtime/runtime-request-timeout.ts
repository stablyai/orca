import { DEFAULT_WAIT_TIMEOUT_SECONDS } from '../../shared/setup-agent-sequencing'
import {
  isWorkerStartTimeoutWithinTimerLimit,
  resolveWorkerStartClientTimeoutMs,
  resolveWorkerStartReadinessTimeoutMs
} from '../../shared/orchestration-timing-budgets'
import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay'
import { RuntimeClientError } from './types'

const LONG_POLL_CLIENT_GRACE_MS = 10_000

export function isWaitingCheck(params: unknown): boolean {
  return (
    typeof params === 'object' &&
    params !== null &&
    'wait' in params &&
    (params as { wait: unknown }).wait === true
  )
}

export function getTimeoutMsParam(params: unknown): unknown {
  if (typeof params !== 'object' || params === null || !('timeoutMs' in params)) {
    return undefined
  }
  return (params as { timeoutMs?: unknown }).timeoutMs
}

// Give server-side waits time to finish before the client transport times out.
export function resolveRuntimeMethodTimeoutMs(
  method: string,
  params: unknown,
  requestTimeoutMs: number
): number {
  if (
    (method === 'agent.launch' || method === 'agent.launchReplay') &&
    typeof params === 'object' &&
    params !== null &&
    'target' in params &&
    typeof params.target === 'object' &&
    params.target !== null &&
    'kind' in params.target &&
    params.target.kind === 'create-worktree'
  ) {
    return Math.max(
      DEFAULT_WAIT_TIMEOUT_SECONDS * 1000 + LONG_POLL_CLIENT_GRACE_MS,
      requestTimeoutMs
    )
  }
  if (method === 'orchestration.workerStart') {
    const requestedValue = getTimeoutMsParam(params)
    const requested = typeof requestedValue === 'number' ? requestedValue : Number(requestedValue)
    if (!isWorkerStartTimeoutWithinTimerLimit(requested)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--timeout-ms is too large for worker-start transport grace; the derived timeout must be <= ${MAX_TIMER_DELAY_MS}ms.`
      )
    }
    const readiness = resolveWorkerStartReadinessTimeoutMs(requested)
    return Math.max(resolveWorkerStartClientTimeoutMs(readiness), requestTimeoutMs)
  }
  // A send to a finished worker starts its follow-up, which waits as worker-start does.
  if (method === 'orchestration.send') {
    return Math.max(resolveWorkerStartClientTimeoutMs(), requestTimeoutMs)
  }
  if ((method === 'orchestration.check' && isWaitingCheck(params)) || method === 'terminal.wait') {
    const inner = Number(getTimeoutMsParam(params))
    if (Number.isFinite(inner) && inner > 0) {
      return Math.max(inner + LONG_POLL_CLIENT_GRACE_MS, requestTimeoutMs)
    }
  }
  return requestTimeoutMs
}
