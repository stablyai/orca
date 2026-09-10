import type { SQLInputValue } from 'node:sqlite'
import type { MaestroTerminalLeaseTransferReceipt } from '../../../../../shared/maestro-terminal-lease-transfer'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../../db'

export function reconcileMaestroWorkerLeaseTransfer(args: {
  requestId: string
  runtime?: OrcaRuntimeService
  db?: OrchestrationDb
}): MaestroTerminalLeaseTransferReceipt {
  const db = args.db ?? args.runtime?.getOrchestrationDb()
  if (!db) {
    throw new OrchestrationError(
      'invalid_argument',
      'Transfer reconciliation requires an orchestration database.'
    )
  }
  const receipt = db.getMaestroWorkerLeaseTransferReceipt(args.requestId)
  if (!receipt) {
    throw new OrchestrationError('operation_unknown', 'Worker lease transfer receipt is absent.')
  }
  const predecessor = db.getMaestroTerminalLease(receipt.predecessorLeaseId)
  const successor = db.getMaestroTerminalLease(receipt.successorLeaseId)
  const resource = db.getWorkerTerminalResource(receipt.workerTerminalResourceId)
  const priorOwners = resource
    ? parsePriorOwnerDispatchIds(resource.prior_owner_dispatch_ids)
    : undefined
  const activeCount = (where: string, values: SQLInputValue[]): number =>
    (
      db.db
        .prepare(`SELECT count(*) AS count FROM maestro_terminal_leases WHERE ${where}`)
        .get(...values) as { count: number }
    ).count
  const activeLease =
    "role = 'worker' AND lifecycle_state NOT IN ('released', 'superseded', 'archived')"
  const predecessorWorker = db.getWorkerDispatch(receipt.predecessor.dispatchId)
  const valid = Boolean(
    predecessor &&
    successor &&
    resource &&
    receipt.requestId === args.requestId &&
    receipt.predecessorLeaseId === receipt.predecessor.leaseId &&
    receipt.successorLeaseId === receipt.successor.leaseId &&
    receipt.fromDispatchId === receipt.predecessor.dispatchId &&
    matchesTransferParticipant(predecessor, receipt.predecessor) &&
    predecessor.lifecycleState === 'superseded' &&
    predecessor.workerTerminalResourceId === null &&
    matchesTransferParticipant(successor, receipt.successor) &&
    successor.lifecycleState === 'active' &&
    successor.workerTerminalResourceId === receipt.workerTerminalResourceId &&
    matchesReceiptSuccessorIdentity(receipt) &&
    transferKindMatchesParticipants(receipt) &&
    (receipt.kind !== 'settled_resource_reuse' ||
      Boolean(
        predecessorWorker &&
        ['succeeded', 'failed', 'stopped', 'abandoned'].includes(predecessorWorker.state)
      )) &&
    resource.owner_dispatch_id === receipt.successor.dispatchId &&
    resource.ownership_state === 'owned' &&
    resource.release_state === 'not_requested' &&
    resource.terminal_handle === receipt.successor.terminalHandle &&
    resource.pane_key === receipt.successor.paneKey &&
    resource.process_incarnation === receipt.successor.ptyIncarnation &&
    resource.host_scope === receipt.successor.hostScope &&
    priorOwners?.includes(receipt.predecessor.dispatchId) &&
    activeCount(`${activeLease} AND run_id = ? AND task_id = ? AND attempt_id = ?`, [
      receipt.successor.runId,
      receipt.successor.taskId,
      receipt.successor.attemptId
    ]) === 1 &&
    activeCount(`${activeLease} AND worker_terminal_resource_id = ?`, [
      receipt.workerTerminalResourceId
    ]) === 1 &&
    activeCount(
      `${activeLease} AND execution_host_id = ? AND workspace_key = ? AND terminal_handle = ? AND pty_incarnation = ?`,
      [
        receipt.successor.executionHostId,
        receipt.successor.workspaceKey,
        receipt.successor.terminalHandle,
        receipt.successor.ptyIncarnation
      ]
    ) === 1
  )
  if (!valid) {
    throw new OrchestrationError(
      'lease_identity_conflict',
      'Worker lease transfer receipt does not match durable ownership.'
    )
  }
  return receipt
}

function matchesTransferParticipant(
  lease: NonNullable<ReturnType<OrchestrationDb['getMaestroTerminalLease']>>,
  participant: MaestroTerminalLeaseTransferReceipt['predecessor']
): boolean {
  return (
    lease.id === participant.leaseId &&
    participant.ownerPrincipal === `dispatch:${participant.dispatchId}` &&
    lease.ownerPrincipal === participant.ownerPrincipal &&
    lease.runId === participant.runId &&
    lease.taskId === participant.taskId &&
    lease.attemptId === participant.attemptId &&
    lease.terminalHandle === participant.terminalHandle &&
    lease.paneKey === participant.paneKey &&
    lease.ptyIncarnation === participant.ptyIncarnation &&
    lease.processRootId === participant.processRootId &&
    lease.executionHostId === participant.executionHostId &&
    lease.workspaceKey === participant.workspaceKey &&
    lease.coordinatorGeneration === participant.coordinatorGeneration &&
    lease.retentionPolicy === participant.retentionPolicy &&
    JSON.stringify(lease.launchProfile) === JSON.stringify(participant.launchProfile)
  )
}

function matchesReceiptSuccessorIdentity(receipt: MaestroTerminalLeaseTransferReceipt): boolean {
  const { successor } = receipt
  return (
    receipt.runId === successor.runId &&
    receipt.taskId === successor.taskId &&
    receipt.attemptId === successor.attemptId &&
    receipt.terminalHandle === successor.terminalHandle &&
    receipt.ptyIncarnation === successor.ptyIncarnation &&
    receipt.processRootId === successor.processRootId &&
    receipt.executionHostId === successor.executionHostId &&
    receipt.workspaceKey === successor.workspaceKey &&
    receipt.hostScope === successor.hostScope &&
    receipt.successorOwnerPrincipal === successor.ownerPrincipal &&
    receipt.coordinatorGeneration === successor.coordinatorGeneration &&
    receipt.retentionPolicy === successor.retentionPolicy &&
    receipt.toDispatchId === successor.dispatchId &&
    JSON.stringify(receipt.launchProfile) === JSON.stringify(successor.launchProfile)
  )
}

function transferKindMatchesParticipants(receipt: MaestroTerminalLeaseTransferReceipt): boolean {
  const { predecessor, successor } = receipt
  const executionIdentityMatches =
    predecessor.paneKey === successor.paneKey &&
    predecessor.ptyIncarnation === successor.ptyIncarnation &&
    predecessor.processRootId === successor.processRootId &&
    predecessor.executionHostId === successor.executionHostId &&
    predecessor.workspaceKey === successor.workspaceKey &&
    predecessor.hostScope === successor.hostScope
  if (!executionIdentityMatches) {
    return false
  }
  if (receipt.kind === 'settled_resource_reuse') {
    return (
      predecessor.attemptId !== successor.attemptId &&
      predecessor.dispatchId !== successor.dispatchId
    )
  }
  return (
    predecessor.runId === successor.runId &&
    predecessor.taskId === successor.taskId &&
    predecessor.attemptId === successor.attemptId &&
    predecessor.terminalHandle === successor.terminalHandle &&
    predecessor.coordinatorGeneration === successor.coordinatorGeneration &&
    predecessor.retentionPolicy === successor.retentionPolicy &&
    JSON.stringify(predecessor.launchProfile) === JSON.stringify(successor.launchProfile)
  )
}

function parsePriorOwnerDispatchIds(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) {
      return parsed
    }
  } catch {}
  throw new OrchestrationError(
    'lease_identity_conflict',
    'Worker terminal prior-owner identity is invalid.'
  )
}
