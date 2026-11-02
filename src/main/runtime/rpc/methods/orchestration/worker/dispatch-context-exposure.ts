import { parseWorkerTerminalHostScope } from '../../../../../../shared/worker-terminal-host-scope'
import type { DispatchContextRow } from '../../../../orchestration/types'

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
