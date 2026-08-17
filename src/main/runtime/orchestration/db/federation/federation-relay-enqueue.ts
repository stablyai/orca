import type {
  WorkerReportOutcome,
  FederationRelayDirection,
  FederationRelayItemRow
} from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

export function enqueueFederationRelay(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    direction: FederationRelayDirection
    kind: string
    payload: string
    messageId?: string
    settleRemoteOutcome?: WorkerReportOutcome
    remoteQuestion?: true
  }
): FederationRelayItemRow {
  const byteCount = Buffer.byteLength(params.payload, 'utf8')
  const messageId = params.messageId ?? generateId('relay')
  if (byteCount > 64 * 1024) {
    throw new OrchestrationError(
      'relay_quota_exceeded',
      'A federated orchestration message cannot exceed 64 KiB.'
    )
  }
  this.db.exec('BEGIN IMMEDIATE')
  try {
    if (params.settleRemoteOutcome) {
      const attachment = this.getRemoteDispatchAttachment(params.dispatchId)
      if (!attachment || attachment.state !== 'ready') {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Remote Dispatch ${params.dispatchId} is not active.`
        )
      }
    }
    if (params.kind === 'heartbeat') {
      const heartbeat = this.db
        .prepare(
          `SELECT * FROM federation_relay_items
           WHERE dispatch_id = ? AND direction = ? AND kind = 'heartbeat'
             AND acked_at IS NULL
           ORDER BY sequence DESC LIMIT 1`
        )
        .get(params.dispatchId, params.direction) as FederationRelayItemRow | undefined
      if (heartbeat) {
        this.db
          .prepare(
            `UPDATE federation_relay_items
             SET payload = ?, byte_count = ?, created_at = datetime('now')
             WHERE dispatch_id = ? AND direction = ? AND sequence = ?`
          )
          .run(params.payload, byteCount, params.dispatchId, params.direction, heartbeat.sequence)
        this.db.exec('COMMIT')
        return this.getFederationRelayItem(
          params.dispatchId,
          params.direction,
          heartbeat.sequence
        ) as FederationRelayItemRow
      }
    }
    if (params.kind === 'worker_done') {
      const identicalReport = this.db
        .prepare(
          `SELECT * FROM federation_relay_items
           WHERE dispatch_id = ? AND direction = ? AND kind = 'worker_done'
             AND payload = ? AND acked_at IS NULL
           ORDER BY sequence DESC LIMIT 1`
        )
        .get(params.dispatchId, params.direction, params.payload) as
        | FederationRelayItemRow
        | undefined
      if (identicalReport) {
        this.settleRemoteAttachmentInRelayTransaction(params.dispatchId, params.settleRemoteOutcome)
        this.db.exec('COMMIT')
        return identicalReport
      }
    }
    const quota = this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(byte_count), 0) AS bytes
         FROM federation_relay_items
         WHERE dispatch_id = ? AND direction = ? AND acked_at IS NULL`
      )
      .get(params.dispatchId, params.direction) as { count: number; bytes: number }
    if (quota.count >= 256 || quota.bytes + byteCount > 1024 * 1024) {
      if (params.kind === 'worker_done') {
        const heartbeat = this.db
          .prepare(
            `SELECT * FROM federation_relay_items
             WHERE dispatch_id = ? AND direction = ? AND kind = 'heartbeat'
               AND acked_at IS NULL
             ORDER BY sequence LIMIT 1`
          )
          .get(params.dispatchId, params.direction) as FederationRelayItemRow | undefined
        if (heartbeat) {
          this.db
            .prepare(
              `UPDATE federation_relay_items
               SET message_id = ?, kind = ?, payload = ?, byte_count = ?,
                   created_at = datetime('now')
               WHERE dispatch_id = ? AND direction = ? AND sequence = ?`
            )
            .run(
              messageId,
              params.kind,
              params.payload,
              byteCount,
              params.dispatchId,
              params.direction,
              heartbeat.sequence
            )
          this.settleRemoteAttachmentInRelayTransaction(
            params.dispatchId,
            params.settleRemoteOutcome
          )
          this.db.exec('COMMIT')
          return this.getFederationRelayItem(
            params.dispatchId,
            params.direction,
            heartbeat.sequence
          ) as FederationRelayItemRow
        }
      }
      throw new OrchestrationError(
        'relay_quota_exceeded',
        `Federated Dispatch ${params.dispatchId} has no relay capacity.`
      )
    }
    const latest = this.db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) AS sequence
         FROM federation_relay_items WHERE dispatch_id = ? AND direction = ?`
      )
      .get(params.dispatchId, params.direction) as { sequence: number }
    const sequence = latest.sequence + 1
    this.db
      .prepare(
        `INSERT INTO federation_relay_items (
           dispatch_id, direction, sequence, message_id, kind, payload, byte_count
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.dispatchId,
        params.direction,
        sequence,
        messageId,
        params.kind,
        params.payload,
        byteCount
      )
    if (params.remoteQuestion) {
      this.db
        .prepare(
          `INSERT INTO remote_questions (message_id, dispatch_id)
           VALUES (?, ?)`
        )
        .run(messageId, params.dispatchId)
    }
    this.settleRemoteAttachmentInRelayTransaction(params.dispatchId, params.settleRemoteOutcome)
    this.db.exec('COMMIT')
    return this.getFederationRelayItem(
      params.dispatchId,
      params.direction,
      sequence
    ) as FederationRelayItemRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type FederationRelayEnqueueMethods = {
  enqueueFederationRelay: typeof enqueueFederationRelay
}

export function attachFederationRelayEnqueue(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    enqueueFederationRelay
  })
}
