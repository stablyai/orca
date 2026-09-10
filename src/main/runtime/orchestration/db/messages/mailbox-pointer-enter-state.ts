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

export type MailboxPointerReservation = {
  id: string
  read: number
  pointer_pty_id: string
  pointer_process_incarnation: string
  pointer_enter_pending: number
  to_handle: string
}

const RESERVATION_COLUMNS =
  'id, read, pointer_pty_id, pointer_process_incarnation, pointer_enter_pending, to_handle'

// Served by idx_messages_pending_pointer_pty; named columns keep the statement cacheable.
export function getMailboxPointerReservationsForPty(
  this: OrchestrationDb,
  ptyId: string
): MailboxPointerReservation[] {
  return this.db
    .prepare(
      `SELECT ${RESERVATION_COLUMNS} FROM messages
       WHERE pointer_pty_id = ? AND pointer_enter_pending > 0`
    )
    .all(ptyId) as MailboxPointerReservation[]
}

export function getMailboxPointerReservations(this: OrchestrationDb): MailboxPointerReservation[] {
  return this.db
    .prepare(`SELECT ${RESERVATION_COLUMNS} FROM messages WHERE pointer_enter_pending > 0`)
    .all() as MailboxPointerReservation[]
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
  getMailboxPointerReservations: typeof getMailboxPointerReservations
  getMailboxPointerReservationsForPty: typeof getMailboxPointerReservationsForPty
  getPendingMailboxPointerMessages: typeof getPendingMailboxPointerMessages
  getPendingMailboxPointerHandles: typeof getPendingMailboxPointerHandles
  stageMailboxPointerEnter: typeof stageMailboxPointerEnter
  markMailboxPointerWriteAttempted: typeof markMailboxPointerWriteAttempted
  markMailboxPointerEnterAttempted: typeof markMailboxPointerEnterAttempted
  settleMailboxPointerEnter: typeof settleMailboxPointerEnter
  releaseMailboxPointerEnter: typeof releaseMailboxPointerEnter
}

export function attachMailboxPointerEnterState(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getMailboxPointerReservations,
    getMailboxPointerReservationsForPty,
    getPendingMailboxPointerMessages,
    getPendingMailboxPointerHandles,
    stageMailboxPointerEnter,
    markMailboxPointerWriteAttempted,
    markMailboxPointerEnterAttempted,
    settleMailboxPointerEnter,
    releaseMailboxPointerEnter
  })
}
