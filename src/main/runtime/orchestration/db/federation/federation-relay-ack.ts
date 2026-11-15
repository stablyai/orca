import type { FederationRelayDirection, FederationRelayItemRow } from '../orchestration-records'
import type { FederationRelayAcknowledgment } from '../../legacy-remote/federation-relay-report-acknowledgment'
import type { OrchestrationDb } from '../orchestration-db'

export function listPendingFederationRelay(
  this: OrchestrationDb,
  dispatchId: string,
  direction: FederationRelayDirection,
  limit = 50
): FederationRelayItemRow[] {
  return this.db
    .prepare(
      `SELECT * FROM federation_relay_items
       WHERE dispatch_id = ? AND direction = ? AND acked_at IS NULL
       ORDER BY sequence LIMIT ?`
    )
    .all(dispatchId, direction, Math.min(Math.max(limit, 1), 50)) as FederationRelayItemRow[]
}

export function acknowledgeFederationRelay(
  this: OrchestrationDb,
  params: FederationRelayAcknowledgment
): void {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.settleRemoteReportsInRelayAcknowledgment(params)
    this.db
      .prepare(
        `UPDATE federation_relay_items SET acked_at = COALESCE(acked_at, datetime('now'))
         WHERE dispatch_id = ? AND direction = ? AND sequence <= ?`
      )
      .run(params.dispatchId, params.direction, params.throughSequence)
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type FederationRelayAckMethods = {
  listPendingFederationRelay: typeof listPendingFederationRelay
  acknowledgeFederationRelay: typeof acknowledgeFederationRelay
}

export function attachFederationRelayAck(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    listPendingFederationRelay,
    acknowledgeFederationRelay
  })
}
