import type { MessageRow } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT } from './mailbox-routing-page'

export const MAILBOX_POINTER_RESERVED = 1
export const MAILBOX_POINTER_WRITE_ATTEMPTED = 2
export const MAILBOX_POINTER_ENTER_ATTEMPTED = 3

export type MailboxPointerReservationTarget = {
  ptyId: string
  processIncarnation: string
}

export function getPendingMailboxPointerMessages(
  this: OrchestrationDb,
  mailboxHandle: string
): MessageRow[] {
  return this.db
    .prepare(
      `SELECT * FROM messages
       WHERE to_handle = ? AND read = 0 AND pointer_enter_pending > 0
         AND delivery_contract = 'current_delivery'
       ORDER BY sequence LIMIT ?`
    )
    .all(mailboxHandle, ORCHESTRATION_DELIVERY_BATCH_LIMIT) as MessageRow[]
}

export function getPendingMailboxPointerHandles(this: OrchestrationDb): string[] {
  return (
    this.db
      .prepare(
        `SELECT DISTINCT to_handle FROM messages
         WHERE read = 0 AND pointer_enter_pending > 0
           AND delivery_contract = 'current_delivery'`
      )
      .all() as { to_handle: string }[]
  ).map((row) => row.to_handle)
}

export function stageMailboxPointerEnter(
  this: OrchestrationDb,
  ids: string[],
  target: MailboxPointerReservationTarget
): boolean {
  return (
    mutatePointerMessages(
      this,
      ids,
      (placeholders) => ({
        sql: `UPDATE messages
          SET pointer_enter_pending = ?,
              pointer_pty_id = ?, pointer_process_incarnation = ?
          WHERE read = 0 AND pointer_enter_pending = 0
            AND id IN (${placeholders})`,
        leadingParams: [MAILBOX_POINTER_RESERVED, target.ptyId, target.processIncarnation]
      }),
      { requireAll: true }
    ) === ids.length
  )
}

export function markMailboxPointerWriteAttempted(
  this: OrchestrationDb,
  ids: string[],
  target: MailboxPointerReservationTarget
): boolean {
  return (
    mutatePointerMessages(
      this,
      ids,
      (placeholders) => ({
        sql: `UPDATE messages
          SET pointer_enter_pending = ?
          WHERE read = 0 AND pointer_enter_pending = ?
            AND pointer_pty_id = ? AND pointer_process_incarnation = ?
            AND id IN (${placeholders})`,
        leadingParams: [
          MAILBOX_POINTER_WRITE_ATTEMPTED,
          MAILBOX_POINTER_RESERVED,
          target.ptyId,
          target.processIncarnation
        ]
      }),
      { requireAll: true }
    ) === ids.length
  )
}

export function markMailboxPointerEnterAttempted(
  this: OrchestrationDb,
  ids: string[],
  target: MailboxPointerReservationTarget
): boolean {
  return (
    mutatePointerMessages(
      this,
      ids,
      (placeholders) => ({
        sql: `UPDATE messages
          SET pointer_enter_pending = ?
          WHERE read = 0 AND pointer_enter_pending = ?
            AND pointer_pty_id = ? AND pointer_process_incarnation = ?
            AND id IN (${placeholders})`,
        leadingParams: [
          MAILBOX_POINTER_ENTER_ATTEMPTED,
          MAILBOX_POINTER_WRITE_ATTEMPTED,
          target.ptyId,
          target.processIncarnation
        ]
      }),
      { requireAll: true }
    ) === ids.length
  )
}

export function settleMailboxPointerEnter(
  this: OrchestrationDb,
  ids: string[],
  target: MailboxPointerReservationTarget,
  expectedPhases: readonly number[]
): void {
  if (expectedPhases.length === 0) {
    return
  }
  mutatePointerMessages(this, ids, (placeholders) => ({
    sql: `UPDATE messages
          SET delivered_at = COALESCE(delivered_at, datetime('now')),
              pointer_enter_pending = 0, pointer_pty_id = NULL,
              pointer_process_incarnation = NULL
          WHERE pointer_pty_id = ? AND pointer_process_incarnation = ?
            AND pointer_enter_pending IN (${expectedPhases.map(() => '?').join(',')})
            AND id IN (${placeholders})`,
    leadingParams: [target.ptyId, target.processIncarnation, ...expectedPhases]
  }))
}

export function releaseMailboxPointerEnter(
  this: OrchestrationDb,
  ids: string[],
  target: MailboxPointerReservationTarget,
  expectedPhases: readonly number[]
): void {
  if (expectedPhases.length === 0) {
    return
  }
  mutatePointerMessages(this, ids, (placeholders) => ({
    sql: `UPDATE messages
          SET delivered_at = NULL, pointer_enter_pending = 0,
              pointer_pty_id = NULL, pointer_process_incarnation = NULL
          WHERE read = 0 AND pointer_pty_id = ? AND pointer_process_incarnation = ?
            AND pointer_enter_pending IN (${expectedPhases.map(() => '?').join(',')})
            AND id IN (${placeholders})`,
    leadingParams: [target.ptyId, target.processIncarnation, ...expectedPhases]
  }))
}

export function releasePendingMailboxPointerForPty(this: OrchestrationDb, ptyId: string): void {
  this.db
    .prepare(
      `UPDATE messages
       SET delivered_at = CASE
             WHEN read = 0 AND pointer_enter_pending = ? THEN NULL
             WHEN read = 0 THEN COALESCE(delivered_at, datetime('now'))
             ELSE delivered_at
           END,
           pointer_enter_pending = 0, pointer_pty_id = NULL,
           pointer_process_incarnation = NULL
       WHERE pointer_enter_pending > 0 AND pointer_pty_id = ?`
    )
    .run(MAILBOX_POINTER_RESERVED, ptyId)
}

function mutatePointerMessages(
  db: OrchestrationDb,
  ids: string[],
  build: (placeholders: string) => { sql: string; leadingParams: (string | number)[] },
  options?: { requireAll?: boolean }
): number {
  if (ids.length === 0) {
    return 0
  }
  let changed = 0
  db.db.exec('SAVEPOINT mailbox_pointer_enter_mutation')
  try {
    for (let offset = 0; offset < ids.length; offset += ORCHESTRATION_DELIVERY_BATCH_LIMIT) {
      const batch = ids.slice(offset, offset + ORCHESTRATION_DELIVERY_BATCH_LIMIT)
      const mutation = build(batch.map(() => '?').join(','))
      changed += Number(
        db.db.prepare(mutation.sql).run(...mutation.leadingParams, ...batch).changes
      )
    }
    if (options?.requireAll && changed !== ids.length) {
      db.db.exec('ROLLBACK TO mailbox_pointer_enter_mutation')
      db.db.exec('RELEASE mailbox_pointer_enter_mutation')
      return 0
    }
    db.db.exec('RELEASE mailbox_pointer_enter_mutation')
    return changed
  } catch (error) {
    db.db.exec('ROLLBACK TO mailbox_pointer_enter_mutation')
    db.db.exec('RELEASE mailbox_pointer_enter_mutation')
    throw error
  }
}

export type MailboxPointerEnterStateMethods = {
  getPendingMailboxPointerMessages: typeof getPendingMailboxPointerMessages
  getPendingMailboxPointerHandles: typeof getPendingMailboxPointerHandles
  stageMailboxPointerEnter: typeof stageMailboxPointerEnter
  markMailboxPointerWriteAttempted: typeof markMailboxPointerWriteAttempted
  markMailboxPointerEnterAttempted: typeof markMailboxPointerEnterAttempted
  settleMailboxPointerEnter: typeof settleMailboxPointerEnter
  releaseMailboxPointerEnter: typeof releaseMailboxPointerEnter
  releasePendingMailboxPointerForPty: typeof releasePendingMailboxPointerForPty
}

export function attachMailboxPointerEnterState(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getPendingMailboxPointerMessages,
    getPendingMailboxPointerHandles,
    stageMailboxPointerEnter,
    markMailboxPointerWriteAttempted,
    markMailboxPointerEnterAttempted,
    settleMailboxPointerEnter,
    releaseMailboxPointerEnter,
    releasePendingMailboxPointerForPty
  })
}
