import type { OrchestrationAgentView, OrchestrationFailure } from './agent-view'
import type { WorkerReleaseReceipt } from './worker-output'

type WorkerReleaseFields = {
  dispatchId: string
  state: string
  reason?: string
  processAction: string
  archive?: string
  lastError?: string
  next?: string
}

export const WORKER_RELEASE_VIEW: OrchestrationAgentView<
  WorkerReleaseReceipt,
  WorkerReleaseFields
> = {
  fields: (value) => ({
    dispatchId: value.dispatchId,
    state: value.state,
    reason: value.reason,
    processAction: value.processAction,
    archive: value.archive?.source
      ? `${value.archive.source} [${value.archive.status ?? 'unknown'}]`
      : undefined,
    lastError: value.lastError,
    next: value.recovery
  }),
  // Retained, pending, and already-released are settled outcomes; only release_unknown fails.
  failure: (value) =>
    value.state === 'release_unknown'
      ? {
          code: 'release_unknown',
          message: value.lastError ?? `Release of ${value.dispatchId} is unconfirmed.`
        }
      : undefined
}

export function workerStopFailure(value: {
  dispatchId: string
  state: string
  lastError?: string
}): OrchestrationFailure | undefined {
  return value.state === 'stop_unknown'
    ? {
        code: 'stop_unknown',
        message: value.lastError ?? `Stop of ${value.dispatchId} is unconfirmed.`
      }
    : undefined
}
