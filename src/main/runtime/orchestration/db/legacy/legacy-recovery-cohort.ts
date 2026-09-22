import type { MessageType, MessageRow, LegacyCompatibilityPrincipalRow } from '../../types'
import { LEGACY_CONTRACT_VERSION } from '../contract-constants'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT } from '../messages/mailbox-routing-page'
import { exposeMessageListTimestamps } from '../utc-timestamp'
import type { OrchestrationDb } from '../orchestration-db'

export function initializeLegacyRecoveryCohort(
  this: OrchestrationDb,
  principal: LegacyCompatibilityPrincipalRow
): void {
  if (principal.role === 'worker') {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO legacy_mail_receipts (
           principal_id, message_id, acknowledged_at
         )
         SELECT ?, m.id, NULL
         FROM messages m
         INNER JOIN dispatch_contexts d ON d.id = ?
         WHERE m.run_id = ? AND m.delivery_contract = 'legacy_direct' AND m.read = 1
           AND d.status IN ('pending', 'dispatched')
           AND m.created_at >= d.created_at
           AND (m.to_handle = ? OR m.to_handle = ?)`
      )
      .run(
        principal.id,
        principal.dispatch_id,
        principal.run_id,
        principal.terminal_handle,
        `dispatch:${principal.dispatch_id}`
      )
    return
  }
  this.db
    .prepare(
      `INSERT OR IGNORE INTO legacy_mail_receipts (
         principal_id, message_id, acknowledged_at
       )
       SELECT ?, m.id, NULL
       FROM messages m
       WHERE m.run_id = ? AND m.delivery_contract = 'legacy_direct' AND m.read = 1
         AND m.to_handle = ?
         AND EXISTS(
           SELECT 1 FROM dispatch_contexts d
           WHERE d.run_id = m.run_id
             AND d.contract_version = ?
             AND d.status IN ('pending', 'dispatched')
             AND m.created_at >= d.created_at
             AND (m.from_handle = d.assignee_handle OR m.from_handle = 'dispatch:' || d.id)
         )`
    )
    .run(principal.id, principal.run_id, principal.terminal_handle, LEGACY_CONTRACT_VERSION)
}

export function getLegacyMailPage(
  this: OrchestrationDb,
  params: { principalId: string; limit?: number; types?: MessageType[] }
): {
  messages: MessageRow[]
  recovery: boolean
} {
  const principal = this.requireLegacyMailPrincipal(params.principalId)
  const limit = Math.min(
    Math.max(params.limit ?? ORCHESTRATION_DELIVERY_BATCH_LIMIT, 1),
    ORCHESTRATION_DELIVERY_BATCH_LIMIT
  )
  const addressSql =
    principal.role === 'worker' ? '(m.to_handle = ? OR m.to_handle = ?)' : 'm.to_handle = ?'
  const addressParams =
    principal.role === 'worker'
      ? [principal.terminal_handle, `dispatch:${principal.dispatch_id}`]
      : [principal.terminal_handle]
  const typeSql =
    params.types && params.types.length > 0
      ? `AND m.type IN (${params.types.map(() => '?').join(',')})`
      : ''
  const typeParams = params.types ?? []
  const recovery = this.db
    .prepare(
      `SELECT m.*
       FROM legacy_mail_receipts r
       INNER JOIN messages m ON m.id = r.message_id
       WHERE r.principal_id = ? AND r.acknowledged_at IS NULL
         AND m.run_id = ? AND m.delivery_contract = 'legacy_direct'
         AND ${addressSql}
         ${typeSql}
       ORDER BY m.sequence ASC LIMIT ?`
    )
    .all(
      params.principalId,
      principal.run_id,
      ...addressParams,
      ...typeParams,
      limit
    ) as MessageRow[]
  if (recovery.length > 0) {
    return { messages: exposeMessageListTimestamps(recovery), recovery: true }
  }

  const unread = this.db
    .prepare(
      `SELECT m.*
       FROM messages m
       LEFT JOIN legacy_mail_receipts r
         ON r.principal_id = ? AND r.message_id = m.id
       WHERE m.run_id = ? AND m.delivery_contract = 'legacy_direct'
         AND m.read = 0 AND r.message_id IS NULL AND ${addressSql}
         ${typeSql}
       ORDER BY m.sequence ASC LIMIT ?`
    )
    .all(
      params.principalId,
      principal.run_id,
      ...addressParams,
      ...typeParams,
      limit
    ) as MessageRow[]
  return { messages: exposeMessageListTimestamps(unread), recovery: false }
}

export function getLegacyMailHistory(
  this: OrchestrationDb,
  params: { principalId: string; limit?: number; types?: MessageType[] }
): {
  messages: MessageRow[]
  recovery: false
} {
  const principal = this.requireLegacyMailPrincipal(params.principalId)
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 100)
  const addressSql =
    principal.role === 'worker' ? '(to_handle = ? OR to_handle = ?)' : 'to_handle = ?'
  const addressParams =
    principal.role === 'worker'
      ? [principal.terminal_handle, `dispatch:${principal.dispatch_id}`]
      : [principal.terminal_handle]
  const typeSql =
    params.types && params.types.length > 0
      ? `AND type IN (${params.types.map(() => '?').join(',')})`
      : ''
  const messages = this.db
    .prepare(
      `SELECT * FROM messages
       WHERE run_id = ? AND delivery_contract = 'legacy_direct'
         AND ${addressSql} ${typeSql}
       ORDER BY sequence ASC LIMIT ?`
    )
    .all(principal.run_id, ...addressParams, ...(params.types ?? []), limit) as MessageRow[]
  return { messages: exposeMessageListTimestamps(messages), recovery: false }
}

export type LegacyRecoveryCohortMethods = {
  initializeLegacyRecoveryCohort: typeof initializeLegacyRecoveryCohort
  getLegacyMailPage: typeof getLegacyMailPage
  getLegacyMailHistory: typeof getLegacyMailHistory
}

export function attachLegacyRecoveryCohort(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    initializeLegacyRecoveryCohort,
    getLegacyMailPage,
    getLegacyMailHistory
  })
}
