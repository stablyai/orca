import type { MessageType, MessageRow, LegacyMailReceiptRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

export function acknowledgeLegacyMail(
  this: OrchestrationDb,
  params: {
    principalId: string
    messageIds: string[]
    types?: MessageType[]
  }
): {
  receipts: LegacyMailReceiptRow[]
  duplicate: boolean
} {
  if (params.messageIds.length === 0) {
    return { receipts: [], duplicate: true }
  }
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const principal = this.requireLegacyMailPrincipal(params.principalId)
    const uniqueIds = [...new Set(params.messageIds)]
    const placeholders = uniqueIds.map(() => '?').join(',')
    const prior = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM legacy_mail_receipts
         WHERE principal_id = ? AND message_id IN (${placeholders})
           AND acknowledged_at IS NOT NULL`
      )
      .get(params.principalId, ...uniqueIds) as { count: number }
    if (prior.count !== uniqueIds.length) {
      const actionable = this.getLegacyMailPage({
        principalId: params.principalId,
        limit: uniqueIds.length,
        types: params.types
      }).messages
      if (
        actionable.length !== uniqueIds.length ||
        actionable.some((message, index) => message.id !== uniqueIds[index])
      ) {
        throw new OrchestrationError(
          'request_mismatch',
          'Legacy mail acknowledgment does not match the current replay page.'
        )
      }
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE id IN (${placeholders}) AND run_id = ?
           AND delivery_contract = 'legacy_direct'`
      )
      .all(...uniqueIds, principal.run_id) as MessageRow[]
    const validIds = new Set(
      rows
        .filter(
          (message) =>
            message.to_handle === principal.terminal_handle ||
            (principal.role === 'worker' &&
              message.to_handle === `dispatch:${principal.dispatch_id}`)
        )
        .map((message) => message.id)
    )
    if (validIds.size !== uniqueIds.length || uniqueIds.some((id) => !validIds.has(id))) {
      throw new OrchestrationError(
        'request_mismatch',
        'Legacy mail acknowledgment contains a message outside this principal inbox.'
      )
    }

    this.db
      .prepare(
        `UPDATE messages
         SET read = 1, delivered_at = COALESCE(delivered_at, datetime('now'))
         WHERE id IN (${placeholders})`
      )
      .run(...uniqueIds)
    const insert = this.db.prepare(
      `INSERT INTO legacy_mail_receipts (
         principal_id, message_id, acknowledged_at
       ) VALUES (?, ?, datetime('now'))
       ON CONFLICT(principal_id, message_id)
       DO UPDATE SET acknowledged_at = COALESCE(
         legacy_mail_receipts.acknowledged_at, excluded.acknowledged_at
       )`
    )
    for (const messageId of uniqueIds) {
      insert.run(params.principalId, messageId)
    }
    const receipts = this.db
      .prepare(
        `SELECT * FROM legacy_mail_receipts
         WHERE principal_id = ? AND message_id IN (${placeholders})
         ORDER BY message_id`
      )
      .all(params.principalId, ...uniqueIds) as LegacyMailReceiptRow[]
    this.db.exec('COMMIT')
    return { receipts, duplicate: prior.count === uniqueIds.length }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type LegacyMailAcknowledgeMethods = {
  acknowledgeLegacyMail: typeof acknowledgeLegacyMail
}

export function attachLegacyMailAcknowledge(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    acknowledgeLegacyMail
  })
}
