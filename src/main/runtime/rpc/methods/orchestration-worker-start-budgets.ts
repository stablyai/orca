import {
  ORCHESTRATION_CONTRACT_PREFLIGHT_TIMEOUT_MS,
  isWorkerStartTimeoutWithinTimerLimit,
  resolveFederationAttachDeadlineMs,
  resolveWorkerStartReadinessTimeoutMs,
  resolveWorkerStartClientTimeoutMs
} from '../../../../shared/orchestration-timing-budgets'

export function resolveFederatedWorkerStartBudgets(
  timeoutMs: number | undefined,
  nowMs = Date.now()
) {
  if (!isWorkerStartTimeoutWithinTimerLimit(timeoutMs)) {
    throw new Error(
      '--timeout-ms is too large for worker-start transport grace; the derived timeout must fit within the timer limit.'
    )
  }
  // Normalize non-positive/invalid values exactly as the client does so local
  // and federated transports share the ordinary default contract.
  const readinessTimeoutMs = resolveWorkerStartReadinessTimeoutMs(timeoutMs)
  const outerDeadlineMs = nowMs + resolveWorkerStartClientTimeoutMs(readinessTimeoutMs)
  return {
    readinessTimeoutMs,
    outerDeadlineMs,
    preflightTimeoutMs: ORCHESTRATION_CONTRACT_PREFLIGHT_TIMEOUT_MS,
    attachDeadlineMs: resolveFederationAttachDeadlineMs({
      readinessTimeoutMs,
      outerDeadlineMs,
      nowMs
    })
  }
}
