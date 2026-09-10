import type {
  MaestroTerminalLaunchProfile,
  MaestroTerminalLease
} from '../../../../../shared/maestro-terminal-lease'
import {
  matchesMaestroTerminalLaunchProfile,
  type MaestroTerminalLeaseTransferParticipantIdentity,
  type MaestroTerminalLeaseTransferReceipt
} from '../../../../../shared/maestro-terminal-lease-transfer'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

export function getMaestroWorkerLeaseTransferReceipt(
  this: OrchestrationDb,
  requestId: string
): MaestroTerminalLeaseTransferReceipt | undefined {
  const row = this.db
    .prepare(
      'SELECT receipt_json FROM maestro_terminal_lease_transfer_receipts WHERE request_id = ?'
    )
    .get(requestId) as { receipt_json: string } | undefined
  if (!row) {
    return undefined
  }
  let receipt: unknown
  try {
    receipt = JSON.parse(row.receipt_json)
  } catch {
    throw new OrchestrationError(
      'lease_identity_conflict',
      'Worker lease transfer receipt is invalid.'
    )
  }
  if (!isWorkerLeaseTransferReceiptV1(receipt)) {
    throw new OrchestrationError(
      'lease_identity_conflict',
      'Worker lease transfer receipt is incomplete.'
    )
  }
  if (receipt.requestId !== requestId) {
    throw new OrchestrationError(
      'lease_identity_conflict',
      'Worker lease transfer receipt request identity differs.'
    )
  }
  return receipt
}

export function getMaestroWorkerLeaseTransferReceiptByMutationRequest(
  this: OrchestrationDb,
  mutation: NonNullable<MaestroTerminalLeaseTransferReceipt['mutation']>
): MaestroTerminalLeaseTransferReceipt | undefined {
  const row = this.db
    .prepare(
      `SELECT request_id FROM maestro_terminal_lease_transfer_receipts
       WHERE mutation_caller_fingerprint = ? AND mutation_request_id = ?
         AND mutation_method = ? AND mutation_payload_hash = ?`
    )
    .get(mutation.callerFingerprint, mutation.requestId, mutation.method, mutation.payloadHash) as
    | { request_id: string }
    | undefined
  const receipt = row ? this.getMaestroWorkerLeaseTransferReceipt(row.request_id) : undefined
  if (receipt && !matchesMutationIdentity(receipt.mutation, mutation)) {
    throw new OrchestrationError(
      'lease_identity_conflict',
      'Transfer receipt mutation identity differs.'
    )
  }
  return receipt
}

export function matchesMutationIdentity(
  left: MaestroTerminalLeaseTransferReceipt['mutation'],
  right: MaestroTerminalLeaseTransferReceipt['mutation']
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function toTransferParticipantIdentity(params: {
  lease: MaestroTerminalLease
  dispatchId: string
  hostScope: string | null
}): MaestroTerminalLeaseTransferParticipantIdentity {
  const { lease } = params
  if (
    !lease.taskId ||
    !lease.attemptId ||
    !lease.terminalHandle ||
    !lease.paneKey ||
    !lease.ptyIncarnation
  ) {
    throw new OrchestrationError(
      'lease_identity_conflict',
      'Worker lease transfer participant identity is incomplete.'
    )
  }
  return {
    leaseId: lease.id,
    dispatchId: params.dispatchId,
    ownerPrincipal: lease.ownerPrincipal,
    runId: lease.runId,
    taskId: lease.taskId,
    attemptId: lease.attemptId,
    terminalHandle: lease.terminalHandle,
    paneKey: lease.paneKey,
    ptyIncarnation: lease.ptyIncarnation,
    processRootId: lease.processRootId,
    executionHostId: lease.executionHostId,
    workspaceKey: lease.workspaceKey,
    hostScope: params.hostScope,
    coordinatorGeneration: lease.coordinatorGeneration,
    launchProfile: lease.launchProfile,
    retentionPolicy: lease.retentionPolicy
  }
}

export function getAcceptedMutationDispatchId(
  receipt: string | null | undefined
): string | undefined {
  if (!receipt) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(receipt)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined
    }
    const accepted = (parsed as { accepted?: unknown }).accepted
    if (!accepted || typeof accepted !== 'object' || Array.isArray(accepted)) {
      return undefined
    }
    const dispatchId = (accepted as { dispatchId?: unknown }).dispatchId
    return typeof dispatchId === 'string' ? dispatchId : undefined
  } catch {
    return undefined
  }
}

function isWorkerLeaseTransferReceiptV1(
  value: unknown
): value is MaestroTerminalLeaseTransferReceipt {
  if (!value || typeof value !== 'object') {
    return false
  }
  const receipt = value as Record<string, unknown>
  const stringFields = [
    'requestId',
    'predecessorLeaseId',
    'successorLeaseId',
    'workerTerminalResourceId',
    'runId',
    'taskId',
    'attemptId',
    'terminalHandle',
    'ptyIncarnation',
    'executionHostId',
    'predecessorOwnerPrincipal',
    'successorOwnerPrincipal',
    'fromDispatchId',
    'toDispatchId',
    'transferredAt'
  ]
  const validShape =
    receipt.version === 1 &&
    (receipt.kind === 'strict_retry' || receipt.kind === 'settled_resource_reuse') &&
    stringFields.every((field) => typeof receipt[field] === 'string' && receipt[field]) &&
    (typeof receipt.processRootId === 'string' || receipt.processRootId === null) &&
    (typeof receipt.hostScope === 'string' || receipt.hostScope === null) &&
    (typeof receipt.coordinatorGeneration === 'number' || receipt.coordinatorGeneration === null) &&
    (receipt.retentionPolicy === 'auto_release' || receipt.retentionPolicy === 'retain') &&
    typeof receipt.workspaceKey === 'string' &&
    isMaestroTerminalLaunchProfile(receipt.launchProfile) &&
    isTransferParticipantIdentity(receipt.predecessor) &&
    isTransferParticipantIdentity(receipt.successor) &&
    isMutationIdentity(receipt.mutation)
  return validShape && hasCoherentTransferReceipt(receipt as MaestroTerminalLeaseTransferReceipt)
}

function hasCoherentTransferReceipt(receipt: MaestroTerminalLeaseTransferReceipt): boolean {
  const { predecessor, successor } = receipt
  const ownerMatchesDispatch =
    predecessor.ownerPrincipal === `dispatch:${predecessor.dispatchId}` &&
    successor.ownerPrincipal === `dispatch:${successor.dispatchId}`
  const topLevelMatchesSuccessor =
    receipt.predecessorLeaseId === predecessor.leaseId &&
    receipt.successorLeaseId === successor.leaseId &&
    receipt.fromDispatchId === predecessor.dispatchId &&
    receipt.toDispatchId === successor.dispatchId &&
    receipt.predecessorOwnerPrincipal === predecessor.ownerPrincipal &&
    receipt.successorOwnerPrincipal === successor.ownerPrincipal &&
    receipt.runId === successor.runId &&
    receipt.taskId === successor.taskId &&
    receipt.attemptId === successor.attemptId &&
    receipt.terminalHandle === successor.terminalHandle &&
    receipt.ptyIncarnation === successor.ptyIncarnation &&
    receipt.processRootId === successor.processRootId &&
    receipt.executionHostId === successor.executionHostId &&
    receipt.workspaceKey === successor.workspaceKey &&
    receipt.hostScope === successor.hostScope &&
    receipt.coordinatorGeneration === successor.coordinatorGeneration &&
    receipt.retentionPolicy === successor.retentionPolicy &&
    matchesMaestroTerminalLaunchProfile(receipt.launchProfile, successor.launchProfile)
  const executionIdentityMatches =
    predecessor.paneKey === successor.paneKey &&
    predecessor.ptyIncarnation === successor.ptyIncarnation &&
    predecessor.processRootId === successor.processRootId &&
    predecessor.executionHostId === successor.executionHostId &&
    predecessor.workspaceKey === successor.workspaceKey &&
    predecessor.hostScope === successor.hostScope
  if (!ownerMatchesDispatch || !topLevelMatchesSuccessor || !executionIdentityMatches) {
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
    matchesMaestroTerminalLaunchProfile(predecessor.launchProfile, successor.launchProfile)
  )
}

function isTransferParticipantIdentity(
  value: unknown
): value is MaestroTerminalLeaseTransferParticipantIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const participant = value as Record<string, unknown>
  const stringFields = [
    'leaseId',
    'dispatchId',
    'ownerPrincipal',
    'runId',
    'taskId',
    'attemptId',
    'terminalHandle',
    'paneKey',
    'ptyIncarnation',
    'executionHostId',
    'workspaceKey'
  ]
  return (
    stringFields.every((field) => typeof participant[field] === 'string' && participant[field]) &&
    (typeof participant.processRootId === 'string' || participant.processRootId === null) &&
    (typeof participant.hostScope === 'string' || participant.hostScope === null) &&
    (typeof participant.coordinatorGeneration === 'number' ||
      participant.coordinatorGeneration === null) &&
    (participant.retentionPolicy === 'auto_release' || participant.retentionPolicy === 'retain') &&
    isMaestroTerminalLaunchProfile(participant.launchProfile)
  )
}

function isMutationIdentity(
  value: unknown
): value is NonNullable<MaestroTerminalLeaseTransferReceipt['mutation']> | null {
  if (value === null) {
    return true
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const mutation = value as Record<string, unknown>
  return ['callerFingerprint', 'requestId', 'method', 'payloadHash'].every(
    (field) => typeof mutation[field] === 'string' && mutation[field]
  )
}

function isMaestroTerminalLaunchProfile(value: unknown): value is MaestroTerminalLaunchProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const profile = value as Record<string, unknown>
  return (
    (typeof profile.agent === 'string' || profile.agent === null) &&
    (typeof profile.model === 'string' || profile.model === null) &&
    (typeof profile.effort === 'string' || profile.effort === null) &&
    typeof profile.permissionMode === 'string' &&
    (typeof profile.routeRef === 'string' || profile.routeRef === null)
  )
}
