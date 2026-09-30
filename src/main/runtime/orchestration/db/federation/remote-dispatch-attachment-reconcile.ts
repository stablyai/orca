import type { RemoteDispatchAttachmentRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { isEquivalentPaneKey } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'

export type ReconcileAbandonedRemoteAttachmentResult = {
  disposition: 'reconciled' | 'already_reconciled'
  attachment: RemoteDispatchAttachmentRow
}

export function reconcileAbandonedRemoteAttachment(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    homePeerFingerprint: string
    expectedRuntimeEpoch: string
    currentRuntimeEpoch: string
    expectedTerminalHandle: string
    expectedPaneKey: string
    expectedProcessIncarnation: string
    rereadObserved: () => {
      paneKey: string | null
      processIncarnation: string | null
      unverifiable: boolean
    }
  }
): ReconcileAbandonedRemoteAttachmentResult {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const attachment = this.getRemoteDispatchAttachment(params.dispatchId)
    if (!attachment || attachment.home_peer_fingerprint !== params.homePeerFingerprint) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Remote Dispatch ${params.dispatchId} was not found for this Run home.`
      )
    }
    if (attachment.state === 'abandoned' && attachment.capability_hash === null) {
      this.db.exec('COMMIT')
      return { disposition: 'already_reconciled', attachment }
    }
    if (!['ready', 'start_unknown'].includes(attachment.state)) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Remote Dispatch ${params.dispatchId} is ${attachment.state}; attachment reconcile did not change it.`
      )
    }
    if (
      attachment.runtime_epoch !== params.expectedRuntimeEpoch ||
      attachment.runtime_epoch !== params.currentRuntimeEpoch
    ) {
      throw new OrchestrationError(
        'runtime_epoch_mismatch',
        `Remote Dispatch ${params.dispatchId} runtime epoch does not match the saved peer.`
      )
    }
    if (attachment.terminal_handle !== params.expectedTerminalHandle) {
      throw new OrchestrationError(
        'worker_identity_changed',
        `Remote Dispatch ${params.dispatchId} terminal does not match the recorded handle.`
      )
    }
    if (
      !attachment.pane_key ||
      !isEquivalentPaneKey(attachment.pane_key, params.expectedPaneKey) ||
      attachment.process_incarnation !== params.expectedProcessIncarnation
    ) {
      throw new OrchestrationError(
        'worker_identity_changed',
        `Remote Dispatch ${params.dispatchId} pane or process incarnation does not match.`
      )
    }
    const observed = params.rereadObserved()
    if (
      observed.unverifiable ||
      !observed.paneKey ||
      !isEquivalentPaneKey(observed.paneKey, attachment.pane_key) ||
      observed.processIncarnation !== attachment.process_incarnation
    ) {
      throw new OrchestrationError(
        observed.unverifiable ? 'unverifiable' : 'worker_identity_changed',
        observed.unverifiable
          ? `Remote Dispatch ${params.dispatchId} liveness is unverifiable; the attachment was not changed.`
          : `Remote Dispatch ${params.dispatchId} changed process before reconcile.`
      )
    }
    const updated = this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET state = 'abandoned', stage = 'attachment_reconciled', capability_hash = NULL,
             consumer_generation = consumer_generation + 1, updated_at = datetime('now')
         WHERE dispatch_id = ? AND state IN ('ready', 'start_unknown')
           AND runtime_epoch = ? AND terminal_handle = ? AND process_incarnation = ?
           AND pane_key = ? AND home_peer_fingerprint = ?`
      )
      .run(
        params.dispatchId,
        attachment.runtime_epoch,
        attachment.terminal_handle,
        attachment.process_incarnation,
        attachment.pane_key,
        params.homePeerFingerprint
      )
    if (updated.changes !== 1) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Remote Dispatch ${params.dispatchId} changed before reconcile could commit.`
      )
    }
    this.fenceUnacknowledgedMailboxDeliveries(`dispatch:${params.dispatchId}`)
    this.db.exec('COMMIT')
    return {
      disposition: 'reconciled',
      attachment: this.getRemoteDispatchAttachment(params.dispatchId) as RemoteDispatchAttachmentRow
    }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type RemoteDispatchAttachmentReconcileMethods = {
  reconcileAbandonedRemoteAttachment: typeof reconcileAbandonedRemoteAttachment
}

export function attachRemoteDispatchAttachmentReconcile(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { reconcileAbandonedRemoteAttachment })
}
