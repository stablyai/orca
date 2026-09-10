import type {
  MaestroTerminalLaunchProfile,
  MaestroTerminalRetentionPolicy
} from '../../../../../shared/maestro-terminal-lease'
import {
  matchesMaestroTerminalLaunchProfile,
  matchesMaestroTerminalLeaseTransferIdentity,
  type MaestroTerminalLeaseTransferIdentity,
  type MaestroTerminalLeaseTransferReceipt
} from '../../../../../shared/maestro-terminal-lease-transfer'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import {
  matchesMutationIdentity,
  toTransferParticipantIdentity
} from './maestro-terminal-lease-transfer-receipt'
import {
  assertCurrentRunTransferGeneration,
  assertPendingTransferMutation
} from './maestro-terminal-lease-transfer-preconditions'

type TransferMaestroWorkerTerminalLeaseParams = {
  requestId: string
  mutation?: {
    callerFingerprint: string
    requestId: string
    method: string
    payloadHash: string
  }
  predecessorLeaseId: string
  successorRequestId: string
  successorDispatchId: string
  attemptId: string
  terminalHandle: string
  paneKey: string
  ptyIncarnation: string
  executionHostId: string
  workspaceKey: string
  title: string
  launchProfile: MaestroTerminalLaunchProfile
  retentionPolicy: MaestroTerminalRetentionPolicy
  spawnedBy: string
} & MaestroTerminalLeaseTransferIdentity

export function transferMaestroWorkerTerminalLease(
  this: OrchestrationDb,
  params: TransferMaestroWorkerTerminalLeaseParams
): MaestroTerminalLeaseTransferReceipt {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const stored = this.getMaestroWorkerLeaseTransferReceipt(params.requestId)
    if (stored) {
      if (
        stored.predecessorLeaseId !== params.predecessorLeaseId ||
        !matchesMaestroTerminalLeaseTransferIdentity(stored, params) ||
        stored.toDispatchId !== params.successorDispatchId ||
        !matchesMutationIdentity(stored.mutation, params.mutation ?? null)
      ) {
        throw new OrchestrationError(
          'mutation_conflict',
          'Terminal lease transfer receipt identity differs.'
        )
      }
      this.db.exec('COMMIT')
      return stored
    }
    assertCurrentRunTransferGeneration(this, params)
    const predecessor = this.getMaestroTerminalLease(params.predecessorLeaseId)
    if (
      !predecessor ||
      predecessor.role !== 'worker' ||
      predecessor.executionHostId !== params.executionHostId ||
      predecessor.workspaceKey !== params.workspaceKey ||
      predecessor.paneKey !== params.paneKey ||
      predecessor.ptyIncarnation !== params.ptyIncarnation ||
      predecessor.processRootId !== params.processRootId ||
      predecessor.ownerPrincipal !== params.predecessorOwnerPrincipal ||
      params.successorOwnerPrincipal !== `dispatch:${params.successorDispatchId}` ||
      !predecessor.workerTerminalResourceId ||
      !['starting', 'ready', 'active', 'input_required', 'settled'].includes(
        predecessor.lifecycleState
      )
    ) {
      throw new OrchestrationError(
        'lease_identity_conflict',
        'Worker lease transfer identity is not authoritative.'
      )
    }
    const resource = this.getWorkerTerminalResource(predecessor.workerTerminalResourceId)
    const predecessorDispatchId = predecessor.ownerPrincipal.startsWith('dispatch:')
      ? predecessor.ownerPrincipal.slice('dispatch:'.length)
      : null
    if (
      !resource ||
      !predecessorDispatchId ||
      predecessor.ownerPrincipal !== `dispatch:${resource.owner_dispatch_id}` ||
      resource.owner_dispatch_id !== predecessorDispatchId ||
      resource.ownership_state !== 'owned' ||
      resource.release_state !== 'not_requested' ||
      resource.terminal_handle !== predecessor.terminalHandle ||
      resource.pane_key !== params.paneKey ||
      resource.process_incarnation !== params.ptyIncarnation ||
      resource.host_scope !== params.hostScope
    ) {
      throw new OrchestrationError(
        'lease_identity_conflict',
        'Worker terminal cleanup authority is no longer transferable.'
      )
    }
    const predecessorWorker = this.getWorkerDispatch(predecessorDispatchId)
    const strictRetry = params.kind === 'strict_retry'
    const settledReuseIdentityInvalid =
      predecessor.attemptId === params.attemptId ||
      predecessorDispatchId === params.successorDispatchId
    if (
      (strictRetry &&
        (predecessor.runId !== params.runId ||
          predecessor.taskId !== params.taskId ||
          predecessor.attemptId !== params.attemptId ||
          predecessor.terminalHandle !== params.terminalHandle ||
          predecessor.coordinatorGeneration !== params.coordinatorGeneration ||
          predecessor.retentionPolicy !== params.retentionPolicy ||
          !matchesMaestroTerminalLaunchProfile(predecessor.launchProfile, params.launchProfile))) ||
      (!strictRetry &&
        (settledReuseIdentityInvalid ||
          !predecessorWorker ||
          !['succeeded', 'failed', 'stopped', 'abandoned'].includes(predecessorWorker.state)))
    ) {
      throw new OrchestrationError(
        'lease_identity_conflict',
        strictRetry
          ? 'Strict retry must preserve the predecessor lease identity.'
          : 'Settled resource reuse requires a settled predecessor and a new Attempt and Dispatch on the exact terminal incarnation.'
      )
    }
    if (this.getMaestroTerminalLeaseByWorkerResource(resource.id)?.id !== predecessor.id) {
      throw new OrchestrationError(
        'lease_identity_conflict',
        'Worker terminal resource has no unique Maestro owner.'
      )
    }
    if (this.getMaestroTerminalLeaseByRequest(params.successorRequestId)) {
      throw new OrchestrationError(
        'mutation_conflict',
        'Terminal lease successor is already reserved.'
      )
    }
    assertPendingTransferMutation(this, params.mutation ?? null, params.successorDispatchId)
    const predecessorIdentity = toTransferParticipantIdentity({
      lease: predecessor,
      dispatchId: predecessorDispatchId,
      hostScope: resource.host_scope
    })
    this.db
      .prepare(
        `UPDATE maestro_terminal_leases
         SET lifecycle_state = 'superseded', worker_terminal_resource_id = NULL,
             updated_at = datetime('now')
         WHERE id = ? AND lifecycle_state != 'superseded'`
      )
      .run(predecessor.id)
    const successor = this.reserveMaestroTerminalLease({
      requestId: params.successorRequestId,
      executionHostId: params.executionHostId,
      workspaceKey: params.workspaceKey,
      runId: params.runId,
      taskId: params.taskId,
      attemptId: params.attemptId,
      coordinatorGeneration: params.coordinatorGeneration,
      role: 'worker',
      workerTerminalResourceId: resource.id,
      title: params.title,
      launchProfile: params.launchProfile,
      parentLeaseId: predecessor.id,
      spawnedBy: params.spawnedBy,
      ownerPrincipal: `dispatch:${params.successorDispatchId}`,
      retentionPolicy: params.retentionPolicy
    })
    this.attachMaestroTerminalLease({
      leaseId: successor.id,
      terminalHandle: params.terminalHandle,
      tabId: predecessor.tabId,
      paneKey: params.paneKey,
      ptyIncarnation: params.ptyIncarnation,
      processRootId: params.processRootId,
      executionHostId: params.executionHostId,
      workspaceKey: params.workspaceKey,
      workerTerminalResourceId: resource.id
    })
    this.transitionMaestroTerminalLease({ leaseId: successor.id, state: 'ready' })
    this.transitionMaestroTerminalLease({ leaseId: successor.id, state: 'active' })
    this.transferWorkerTerminalResourceStatement({
      resourceId: resource.id,
      toDispatchId: params.successorDispatchId,
      terminalHandle: params.terminalHandle,
      paneKey: params.paneKey,
      processIncarnation: params.ptyIncarnation,
      hostScope: params.hostScope
    })
    const attachedSuccessor = this.getMaestroTerminalLease(successor.id)
    if (!attachedSuccessor) {
      throw new OrchestrationError(
        'lease_identity_conflict',
        'Worker lease transfer successor is absent.'
      )
    }
    const receipt: MaestroTerminalLeaseTransferReceipt = {
      version: 1,
      kind: params.kind,
      requestId: params.requestId,
      mutation: params.mutation ?? null,
      predecessorLeaseId: predecessor.id,
      successorLeaseId: successor.id,
      workerTerminalResourceId: resource.id,
      runId: params.runId,
      taskId: params.taskId,
      attemptId: params.attemptId,
      terminalHandle: params.terminalHandle,
      ptyIncarnation: params.ptyIncarnation,
      processRootId: params.processRootId,
      executionHostId: params.executionHostId,
      workspaceKey: params.workspaceKey,
      hostScope: params.hostScope,
      predecessorOwnerPrincipal: params.predecessorOwnerPrincipal,
      successorOwnerPrincipal: params.successorOwnerPrincipal,
      coordinatorGeneration: params.coordinatorGeneration,
      launchProfile: params.launchProfile,
      retentionPolicy: params.retentionPolicy,
      fromDispatchId: predecessorDispatchId,
      toDispatchId: params.successorDispatchId,
      predecessor: predecessorIdentity,
      successor: toTransferParticipantIdentity({
        lease: attachedSuccessor,
        dispatchId: params.successorDispatchId,
        hostScope: params.hostScope
      }),
      transferredAt: new Date().toISOString()
    }
    persistTransferReceipt(this, params, receipt)
    this.db.exec('COMMIT')
    return receipt
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

function persistTransferReceipt(
  db: OrchestrationDb,
  params: TransferMaestroWorkerTerminalLeaseParams,
  receipt: MaestroTerminalLeaseTransferReceipt
): void {
  db.db
    .prepare(
      `INSERT INTO maestro_terminal_lease_transfer_receipts (
        request_id, receipt_json, mutation_caller_fingerprint, mutation_request_id,
        mutation_method, mutation_payload_hash
      ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.requestId,
      JSON.stringify(receipt),
      params.mutation?.callerFingerprint ?? null,
      params.mutation?.requestId ?? null,
      params.mutation?.method ?? null,
      params.mutation?.payloadHash ?? null
    )
  if (!params.mutation) {
    return
  }
  db.db
    .prepare(
      `UPDATE mutation_receipts SET receipt = ?, updated_at = datetime('now')
       WHERE caller_fingerprint = ? AND request_id = ? AND state = 'pending'`
    )
    .run(
      JSON.stringify({
        accepted: { dispatchId: params.successorDispatchId },
        leaseTransfer: receipt
      }),
      params.mutation.callerFingerprint,
      params.mutation.requestId
    )
}
