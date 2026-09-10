import type { OrcaRuntimeService } from '../../../orca-runtime'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import type { RuntimeTerminalShow } from '../../../../../shared/runtime-terminal-contracts'
import type {
  WorkerTerminalArchiveRow,
  WorkerTerminalResourceRow,
  WorkerTerminalRetainedReason
} from '../../worker-terminal-ownership'
import type { WorkerTerminalTailArchive } from '../../worker-output-archive'
import { parseWorkerTerminalHostScope } from '../../worker-terminal-process-liveness'
import type { OrchestrationDb } from '../orchestration-db'

export function workerTerminalLeaseIsCurrent(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatchId: string,
  resource: WorkerTerminalResourceRow,
  observation?: {
    status: string
    terminal: RuntimeTerminalShow | null
    exact: boolean
  }
): boolean {
  if (observation?.status === 'exited') {
    return exitedWorkerTerminalLeaseIsCurrent(
      db,
      dispatchId,
      resource,
      observation.terminal,
      observation.exact
    )
  }
  const worker = db.getWorkerDispatch(dispatchId)
  const authority = runtime.getOrchestrationDispatchAuthority(resource.terminal_handle)
  return Boolean(
    worker?.agent_terminal_handle === resource.terminal_handle &&
    authority &&
    authority.terminalHandle === resource.terminal_handle &&
    resource.worktree_id !== null &&
    resource.worktree_id === authority.worktreeId &&
    resource.pane_key !== null &&
    resource.pane_key === authority.paneKey &&
    resource.process_incarnation !== null &&
    resource.process_incarnation === authority.processIncarnation &&
    resource.host_scope === JSON.stringify(authority.hostScope) &&
    db.isDispatchProcessCurrent({
      dispatchId,
      paneKey: authority.paneKey,
      processIncarnation: authority.processIncarnation
    }) &&
    !db.workerTerminalResourceHasIdentityConflict(resource.id)
  )
}

export function exitedWorkerTerminalLeaseIsCurrent(
  db: OrchestrationDb,
  dispatchId: string,
  resource: WorkerTerminalResourceRow,
  terminal: RuntimeTerminalShow | null,
  exact: boolean
): boolean {
  const worker = db.getWorkerDispatch(dispatchId)
  const expectedHostId = workerTerminalExecutionHostId(resource)
  const observedProcessIncarnation =
    terminal?.ptyId && terminal.incarnationId ? `${terminal.ptyId}:${terminal.incarnationId}` : null
  return Boolean(
    exact &&
    terminal &&
    terminal.handle === resource.terminal_handle &&
    terminal.connected === false &&
    worker?.agent_terminal_handle === resource.terminal_handle &&
    resource.worktree_id !== null &&
    terminal.worktreeId === resource.worktree_id &&
    resource.pane_key !== null &&
    resource.process_incarnation !== null &&
    observedProcessIncarnation === resource.process_incarnation &&
    expectedHostId !== null &&
    terminal.executionHostId === expectedHostId &&
    db.isDispatchProcessCurrent({
      dispatchId,
      paneKey: resource.pane_key,
      processIncarnation: resource.process_incarnation
    }) &&
    !db.workerTerminalResourceHasIdentityConflict(resource.id)
  )
}

export function workerTerminalExecutionHostId(
  resource: WorkerTerminalResourceRow
): ExecutionHostId | null {
  const hostScope = parseWorkerTerminalHostScope(resource.host_scope)
  if (!hostScope) {
    return null
  }
  if (hostScope.kind === 'ssh') {
    return toSshExecutionHostId(hostScope.targetId)
  }
  return hostScope.kind === 'local' ? LOCAL_EXECUTION_HOST_ID : null
}

export function summarizeWorkerTerminalArchive(archive: WorkerTerminalArchiveRow): {
  source: 'transcript' | 'terminal'
  status: 'captured' | 'empty'
} {
  if (archive.kind === 'transcript_pin') {
    return { source: 'transcript', status: 'captured' }
  }
  const content = JSON.parse(archive.content) as WorkerTerminalTailArchive
  return {
    source: 'terminal',
    status: content.lines.every((line) => line.trim() === '') ? 'empty' : 'captured'
  }
}

export function retainedWorkerTerminalReason(
  resource: WorkerTerminalResourceRow
): WorkerTerminalRetainedReason {
  if (resource.retained_reason) {
    return resource.retained_reason as WorkerTerminalRetainedReason
  }
  return resource.ownership_state === 'user_owned' ? 'user_takeover' : 'identity_unproven'
}
