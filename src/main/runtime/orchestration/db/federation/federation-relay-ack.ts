import type { FederationRelayDirection, FederationRelayItemRow } from '../orchestration-records'
import type { FederationRelayAcknowledgment } from '../../legacy-remote/federation-relay-report-acknowledgment'
import type { OrchestrationDb } from '../orchestration-db'
import {
  GROUP_POST_RELAY_KIND,
  GROUP_REPLY_RELAY_KIND
} from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'

export function listPendingFederationRelay(
  this: OrchestrationDb,
  dispatchId: string,
  direction: FederationRelayDirection,
  limit = 50,
  includeGroupPosts = true
): FederationRelayItemRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * returns precisely the relay row.
  return this.db
    .prepare(
      `SELECT * FROM federation_relay_items
       WHERE dispatch_id = ? AND direction = ? AND acked_at IS NULL
         AND (? OR kind NOT IN ('${GROUP_POST_RELAY_KIND}', '${GROUP_REPLY_RELAY_KIND}'))
       ORDER BY sequence LIMIT ?`
    )
    .all(
      dispatchId,
      direction,
      Number(includeGroupPosts),
      Math.min(Math.max(limit, 1), 50)
    ) as FederationRelayItemRow[]
}

export function acknowledgeFederationRelay(
  this: OrchestrationDb,
  params: FederationRelayAcknowledgment,
  includeGroupPosts = true
): void {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.settleRemoteReportsInRelayAcknowledgment(params)
    this.db
      .prepare(
        `UPDATE federation_relay_items SET acked_at = COALESCE(acked_at, datetime('now'))
         WHERE dispatch_id = ? AND direction = ? AND sequence <= ?
           AND (? OR kind NOT IN ('${GROUP_POST_RELAY_KIND}', '${GROUP_REPLY_RELAY_KIND}'))`
      )
      .run(params.dispatchId, params.direction, params.throughSequence, Number(includeGroupPosts))
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
