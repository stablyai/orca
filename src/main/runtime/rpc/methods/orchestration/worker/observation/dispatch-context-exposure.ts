import { parseWorkerTerminalHostScope } from '../../../../../../../shared/orchestration/workers/worker-terminal-host-scope'
import type { DispatchContextRow } from '../../../../../orchestration/db/orchestration-records'

// Hide authority hashes and decode host_scope; emit one camelCase shape matching exposeWorker.
export function exposeDispatchContext(dispatch: DispatchContextRow) {
  return {
    id: dispatch.id,
    runId: dispatch.run_id,
    taskId: dispatch.task_id,
    // Keep dispatch.task_id beside the rename because shipped CLIs still read it.
    task_id: dispatch.task_id,
    contractVersion: dispatch.contract_version,
    assigneeHandle: dispatch.assignee_handle,
    assigneePaneKey: dispatch.assignee_pane_key,
    processIncarnation: dispatch.process_incarnation,
    capabilityRevokedAt: dispatch.capability_revoked_at,
    retryOfDispatchId: dispatch.retry_of_dispatch_id,
    creatorDispatchId: dispatch.creator_dispatch_id,
    followUpOf: dispatch.follow_up_of_dispatch_id,
    hostScope: parseWorkerTerminalHostScope(dispatch.host_scope),
    status: dispatch.status,
    failureCount: dispatch.failure_count,
    lastFailure: dispatch.last_failure,
    terminationReason: dispatch.termination_reason,
    depth: dispatch.depth,
    dispatchedAt: dispatch.dispatched_at,
    completedAt: dispatch.completed_at,
    createdAt: dispatch.created_at,
    lastHeartbeatAt: dispatch.last_heartbeat_at
  }
}

/** An identity observation is not proof that any usage belongs to this Dispatch. */
export function exposeNativeUsageIdentity(dispatch: DispatchContextRow) {
  const unavailable = { status: 'unavailable', reason: 'session_not_reported' } as const
  const raw = dispatch.native_usage_identity
  if (typeof raw !== 'string') {
    return unavailable
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('status' in value)) {
      return unavailable
    }
    const status = value.status
    const reason = 'reason' in value ? value.reason : undefined
    if (
      status === 'unavailable' &&
      (reason === 'session_not_reported' || reason === 'session_changed_or_shared')
    ) {
      return { status: 'unavailable' as const, reason }
    }
    if (
      status === 'observed' &&
      'agent' in value &&
      typeof value.agent === 'string' &&
      value.agent.trim().length > 0 &&
      'sessionId' in value &&
      typeof value.sessionId === 'string' &&
      value.sessionId.trim().length > 0 &&
      'paneKey' in value &&
      typeof value.paneKey === 'string' &&
      value.paneKey.trim().length > 0 &&
      'processIncarnation' in value &&
      typeof value.processIncarnation === 'string' &&
      value.processIncarnation.trim().length > 0 &&
      'hostScope' in value &&
      typeof value.hostScope === 'string' &&
      value.hostScope.trim().length > 0 &&
      'launchTokenHash' in value &&
      typeof value.launchTokenHash === 'string' &&
      value.launchTokenHash.trim().length > 0 &&
      'observedAt' in value &&
      typeof value.observedAt === 'number' &&
      Number.isFinite(value.observedAt)
    ) {
      return {
        status,
        agent: value.agent,
        sessionId: value.sessionId,
        paneKey: value.paneKey,
        processIncarnation: value.processIncarnation,
        hostScope: value.hostScope,
        launchTokenHash: value.launchTokenHash,
        observedAt: value.observedAt,
        profile: { status: 'unavailable', reason: 'profile_not_verified' },
        usageAttribution: { status: 'unavailable', reason: 'segment_ownership_unproven' }
      }
    }
  } catch {
    // Malformed evidence is unavailable, never a reason for worker-show to fail.
  }
  return unavailable
}
