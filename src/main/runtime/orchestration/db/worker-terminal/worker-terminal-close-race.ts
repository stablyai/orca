import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { WorkerTerminalResourceRow } from '../../worker-terminal-ownership'
import type { OrchestrationDb } from '../orchestration-db'
import type { WorkerReleaseReceipt } from '../../../rpc/methods/orchestration/worker/worker-release-completion'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import { parseWorkerTerminalHostScope } from '../../worker-terminal-process-liveness'

export async function settleWorkerTerminalTabNotFoundCloseRace(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  resource: WorkerTerminalResourceRow
  archive: { source: string | null; status: string | null }
  closeResponse: { error: 'tab_not_found'; message: string }
}): Promise<WorkerReleaseReceipt> {
  const expectedHostId = workerTerminalExecutionHostId(args.resource)
  if (!args.resource.worktree_id || !expectedHostId) {
    return unknownRaceReceipt(args)
  }
  const inventory = await args.runtime
    .listTerminals(`id:${args.resource.worktree_id}`, 2, {
      handles: [args.resource.terminal_handle],
      includeVisualLayouts: false,
      requireFreshPtyLiveness: true
    })
    .catch(() => null)
  if (
    !inventory ||
    !inventory.hostScope ||
    inventory.truncated ||
    inventory.hostScope.omittedHostIds.length > 0 ||
    !inventory.hostScope.hostIds.includes(expectedHostId)
  ) {
    return unknownRaceReceipt(args)
  }
  const observed = inventory.terminals[0]
  if (!observed) {
    const released = args.db.settleWorkerTerminalRelease({
      resourceId: args.resource.id,
      ownerDispatchId: args.dispatchId,
      processIncarnation: args.resource.process_incarnation ?? ''
    })
    args.runtime.notifyMessageArrived(`dispatch:${args.dispatchId}`, 'status')
    return raceReceipt(args, 'already_absent', {
      archive: archiveSummary(released),
      inventoryResponse: { state: 'absent' }
    })
  }
  const observedIncarnation = observed.incarnationId
    ? `${observed.ptyId}:${observed.incarnationId}`
    : null
  if (
    observed.worktreeId !== args.resource.worktree_id ||
    observed.executionHostId !== expectedHostId ||
    observedIncarnation !== args.resource.process_incarnation
  ) {
    const retained = args.db.revertWorkerTerminalReleaseToRetained(
      args.resource.id,
      'identity_unproven'
    )
    return raceReceipt(args, 'retained', {
      reason: 'identity_unproven',
      archive: archiveSummary(retained),
      inventoryResponse: { state: 'still_present' }
    })
  }
  return raceReceipt(args, 'release_pending', {
    recovery:
      'The exact terminal is still present after a tab-close race; release remains blocked until a later authoritative reconciliation.',
    inventoryResponse: { state: 'still_present' }
  })
}

function workerTerminalExecutionHostId(
  resource: WorkerTerminalResourceRow
): ExecutionHostId | null {
  const hostScope = parseWorkerTerminalHostScope(resource.host_scope)
  if (!hostScope) {
    return null
  }
  return hostScope.kind === 'ssh'
    ? toSshExecutionHostId(hostScope.targetId)
    : LOCAL_EXECUTION_HOST_ID
}

function unknownRaceReceipt(
  args: Parameters<typeof settleWorkerTerminalTabNotFoundCloseRace>[0]
): WorkerReleaseReceipt {
  const unknown = args.db.markWorkerTerminalReleaseUnknown(
    args.resource.id,
    'The terminal close raced with tab removal, but the terminal inventory could not prove absence.'
  )
  return raceReceipt(args, 'release_unknown', {
    lastError: unknown.release_error ?? undefined,
    inventoryResponse: { state: 'unverifiable' }
  })
}

function raceReceipt(
  args: Parameters<typeof settleWorkerTerminalTabNotFoundCloseRace>[0],
  state: WorkerReleaseReceipt['state'],
  overrides: Partial<WorkerReleaseReceipt>
): WorkerReleaseReceipt {
  return {
    dispatchId: args.dispatchId,
    state,
    processAction: 'none',
    archive: args.archive,
    closeResponse: args.closeResponse,
    ...overrides
  }
}

function archiveSummary(resource: WorkerTerminalResourceRow): WorkerReleaseReceipt['archive'] {
  return resource.archive_source || resource.archive_status
    ? { source: resource.archive_source, status: resource.archive_status }
    : null
}
