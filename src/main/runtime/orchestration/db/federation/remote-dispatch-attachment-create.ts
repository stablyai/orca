import type { WorkerDispatchState, RemoteDispatchAttachmentRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { ensureMutationReceiptCapacity } from '../../mutation-receipt-capacity'
import type { OrchestrationDb } from '../orchestration-db'

export function createRemoteDispatchAttachment(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    taskId: string
    homePeerFingerprint: string
    protocolVersion: number
    runtimeEpoch: string
    mutationReceipt: {
      callerFingerprint: string
      requestId: string
      method: string
      payloadHash: string
    }
  }
): RemoteDispatchAttachmentRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    if (params.homePeerFingerprint !== params.mutationReceipt.callerFingerprint) {
      throw new OrchestrationError(
        'resource_server_mismatch',
        'The authenticated Run-home peer does not match the attachment request.'
      )
    }
    const existingReceipt = this.getMutationReceipt(
      params.mutationReceipt.callerFingerprint,
      params.mutationReceipt.requestId
    )
    if (existingReceipt) {
      throw new OrchestrationError(
        existingReceipt.method === params.mutationReceipt.method &&
          existingReceipt.payload_hash === params.mutationReceipt.payloadHash
          ? 'operation_unknown'
          : 'request_mismatch',
        `Remote attachment request ${params.mutationReceipt.requestId} already exists.`
      )
    }
    ensureMutationReceiptCapacity(this.db)
    this.db
      .prepare(
        `INSERT INTO mutation_receipts (
           caller_fingerprint, request_id, method, payload_hash, state, receipt
         ) VALUES (?, ?, ?, ?, 'pending', ?)`
      )
      .run(
        params.mutationReceipt.callerFingerprint,
        params.mutationReceipt.requestId,
        params.mutationReceipt.method,
        params.mutationReceipt.payloadHash,
        JSON.stringify({ accepted: { dispatchId: params.dispatchId } })
      )
    this.db
      .prepare(
        `INSERT INTO remote_dispatch_attachments (
           dispatch_id, task_id, home_peer_fingerprint, protocol_version, runtime_epoch
         ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        params.dispatchId,
        params.taskId,
        params.homePeerFingerprint,
        params.protocolVersion,
        params.runtimeEpoch
      )
    this.db.exec('COMMIT')
    return this.getRemoteDispatchAttachment(params.dispatchId) as RemoteDispatchAttachmentRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function getRemoteDispatchAttachment(
  this: OrchestrationDb,
  dispatchId: string
): RemoteDispatchAttachmentRow | undefined {
  return this.db
    .prepare('SELECT * FROM remote_dispatch_attachments WHERE dispatch_id = ?')
    .get(dispatchId) as RemoteDispatchAttachmentRow | undefined
}

export function recordRemoteAttachmentStage(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    stage: string
    state?: WorkerDispatchState
    worktreeId?: string
    terminalHandle?: string
    setupState?: string
    effects?: unknown[]
    residualResources?: unknown[]
    lastError?: string
  }
): RemoteDispatchAttachmentRow {
  const current = this.getRemoteDispatchAttachment(params.dispatchId)
  if (!current) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Remote Dispatch ${params.dispatchId} was not found.`
    )
  }
  this.db
    .prepare(
      `UPDATE remote_dispatch_attachments
       SET stage = ?, state = ?, worktree_id = ?, terminal_handle = ?, setup_state = ?,
           effects = ?, residual_resources = ?, last_error = ?, updated_at = datetime('now')
       WHERE dispatch_id = ?`
    )
    .run(
      params.stage,
      params.state ?? current.state,
      params.worktreeId ?? current.worktree_id,
      params.terminalHandle ?? current.terminal_handle,
      params.setupState ?? current.setup_state,
      params.effects ? JSON.stringify(params.effects) : current.effects,
      params.residualResources
        ? JSON.stringify(params.residualResources)
        : current.residual_resources,
      params.lastError ?? current.last_error,
      params.dispatchId
    )
  return this.getRemoteDispatchAttachment(params.dispatchId) as RemoteDispatchAttachmentRow
}

export function updateRemoteAttachmentSetupEvidence(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    setupState: string
    effects: unknown[]
  }
): { attachment: RemoteDispatchAttachmentRow; changed: boolean } {
  const current = this.getRemoteDispatchAttachment(params.dispatchId)
  if (!current) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Remote Dispatch ${params.dispatchId} was not found.`
    )
  }
  const effects = JSON.stringify(params.effects)
  if (current.setup_state === params.setupState && current.effects === effects) {
    return { attachment: current, changed: false }
  }
  this.db
    .prepare(
      `UPDATE remote_dispatch_attachments
       SET setup_state = ?, effects = ?, updated_at = datetime('now')
       WHERE dispatch_id = ?`
    )
    .run(params.setupState, effects, params.dispatchId)
  return {
    attachment: this.getRemoteDispatchAttachment(params.dispatchId) as RemoteDispatchAttachmentRow,
    changed: true
  }
}

export type RemoteDispatchAttachmentCreateMethods = {
  createRemoteDispatchAttachment: typeof createRemoteDispatchAttachment
  getRemoteDispatchAttachment: typeof getRemoteDispatchAttachment
  recordRemoteAttachmentStage: typeof recordRemoteAttachmentStage
  updateRemoteAttachmentSetupEvidence: typeof updateRemoteAttachmentSetupEvidence
}

export function attachRemoteDispatchAttachmentCreate(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createRemoteDispatchAttachment,
    getRemoteDispatchAttachment,
    recordRemoteAttachmentStage,
    updateRemoteAttachmentSetupEvidence
  })
}
