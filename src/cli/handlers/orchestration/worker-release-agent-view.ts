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

export type WorkerStopResult = {
  dispatchId: string
  state: string
  processAction: string
  lastError?: string
  warning?: string
  helpers?: HelperStop[]
}

type HelperStop = {
  dispatchId: string
  creatorDispatchId: string
  outcome: 'stopped' | 'already_finished' | 'kept_open' | 'starting' | 'unconfirmed'
  state?: string
  lastError?: string | null
}

const HELPER_STOP_TEXT: Record<HelperStop['outcome'], string> = {
  stopped: 'stopped',
  already_finished: 'already finished',
  kept_open: 'kept open by the user, not stopped',
  starting: 'starting; stopped once its start finishes',
  unconfirmed: 'stop unconfirmed'
}

export function workerStopFailure(value: WorkerStopResult): OrchestrationFailure | undefined {
  if (value.state === 'stop_unknown') {
    return {
      code: 'stop_unknown',
      message: value.lastError ?? `Stop of ${value.dispatchId} is unconfirmed.`
    }
  }
  const unconfirmed = value.helpers?.filter((helper) => helper.outcome === 'unconfirmed') ?? []
  return unconfirmed.length
    ? {
        code: 'helper_stop_unknown',
        message: `Could not confirm that helpers ${unconfirmed.map((helper) => helper.dispatchId).join(', ')} stopped; check worker-show for each.`
      }
    : undefined
}

export function formatHelperStops(helpers: HelperStop[] | undefined): string {
  return (helpers ?? [])
    .map(
      (helper) =>
        `\nHelper ${helper.dispatchId} (started by ${helper.creatorDispatchId}): ${HELPER_STOP_TEXT[helper.outcome]}${helper.lastError ? ` (${helper.lastError})` : ''}`
    )
    .join('')
}
