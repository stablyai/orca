import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  liveWorkerTerminalAutoReleaseAt,
  type WorkerTerminalResourceRow
} from '../../../../orchestration/worker-terminal-ownership'
import type { WorkerReleaseReceipt } from './worker-release-completion'

export function exposeWorkerTerminalResource(resource: WorkerTerminalResourceRow): {
  id: string
  ownershipState: string
  releaseState: string
  retainedReason: string | null
  terminalHandle: string
  worktreeId: string | null
  endpointId: string | null
  endpointIncarnation: string | null
  originDispatchId: string
  ownerDispatchId: string
  releaseRequestedAt: string | null
  releaseCompletedAt: string | null
  releaseError: string | null
  recoveryAttemptCount: number
  lastRecoveryAt: string | null
  autoReleaseAt: string | null
  archive: { source: string | null; status: string | null }
} {
  return {
    id: resource.id,
    ownershipState: resource.ownership_state,
    releaseState: resource.release_state,
    retainedReason: resource.retained_reason,
    terminalHandle: resource.terminal_handle,
    worktreeId: resource.worktree_id,
    endpointId: resource.endpoint_id,
    endpointIncarnation: resource.endpoint_incarnation,
    originDispatchId: resource.origin_dispatch_id,
    ownerDispatchId: resource.owner_dispatch_id,
    releaseRequestedAt: resource.release_requested_at,
    releaseCompletedAt: resource.release_completed_at,
    releaseError: resource.release_error,
    recoveryAttemptCount: resource.recovery_attempt_count,
    lastRecoveryAt: resource.last_recovery_at,
    autoReleaseAt: liveWorkerTerminalAutoReleaseAt(resource),
    archive: { source: resource.archive_source, status: resource.archive_status }
  }
}

export function archiveSummary(
  resource: WorkerTerminalResourceRow | null
): { source: string | null; status: string | null } | null {
  if (!resource) {
    return null
  }
  if (!resource.archive_source && !resource.archive_status) {
    return null
  }
  return { source: resource.archive_source, status: resource.archive_status }
}

export function exposeWorkerRetainReceipt(
  dispatchId: string,
  retained: ReturnType<OrchestrationDb['retainWorkerTerminalResource']>
): WorkerReleaseReceipt {
  if (retained.disposition === 'already_released') {
    return {
      dispatchId,
      state: 'already_released',
      processAction: 'none',
      archive: archiveSummary(retained.resource)
    }
  }
  if (retained.disposition === 'no_owned_resource') {
    return {
      dispatchId,
      state: 'retained',
      reason: 'no_owned_resource',
      processAction: 'none',
      archive: null
    }
  }
  if (retained.disposition === 'release_committed') {
    return {
      dispatchId,
      state: retained.resource.release_state === 'unknown' ? 'release_unknown' : 'release_pending',
      processAction: 'none',
      archive: archiveSummary(retained.resource),
      ...(retained.resource.release_error ? { lastError: retained.resource.release_error } : {}),
      recovery:
        'Terminal release was already committed and could not be changed to retained; inspect worker-show before taking further action.'
    }
  }
  return {
    dispatchId,
    state: 'retained',
    reason: 'user_requested',
    processAction: 'none',
    archive: archiveSummary(retained.resource)
  }
}
