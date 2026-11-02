import type { OrchestrationDb } from '../orchestration-db'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import type { SqliteRow } from '../../../../sqlite/sqlite-statement'

/** One orchestration message handed to a chat session: the agent-session operation id its send used. */
export type StructuredMailSendRow = {
  mailbox_handle: string
  message_id: string
  session_id: string
  operation_id: string
  minted_at_ms: number
}

const SEND_COLUMNS = 'mailbox_handle, message_id, session_id, operation_id, minted_at_ms'

/** A saved send, read column by column: a row whose values don't fit is not one this build wrote. */
function readStructuredMailSendRow(row: SqliteRow): StructuredMailSendRow | undefined {
  const { mailbox_handle, message_id, session_id, operation_id, minted_at_ms } = row
  return typeof mailbox_handle === 'string' &&
    typeof message_id === 'string' &&
    typeof session_id === 'string' &&
    typeof operation_id === 'string' &&
    typeof minted_at_ms === 'number'
    ? { mailbox_handle, message_id, session_id, operation_id, minted_at_ms }
    : undefined
}

export function getStructuredMailSends(
  this: OrchestrationDb,
  mailboxHandle: string
): StructuredMailSendRow[] {
  return this.db
    .prepare(
      `SELECT ${SEND_COLUMNS} FROM structured_mail_sends WHERE mailbox_handle = ? ORDER BY minted_at_ms`
    )
    .all(mailboxHandle)
    .flatMap((row) => readStructuredMailSendRow(row) ?? [])
}

export function getStructuredMailSend(
  this: OrchestrationDb,
  mailboxHandle: string,
  messageId: string
): StructuredMailSendRow | undefined {
  const row = this.db
    .prepare(
      `SELECT ${SEND_COLUMNS} FROM structured_mail_sends WHERE mailbox_handle = ? AND message_id = ?`
    )
    .get(mailboxHandle, messageId)
  return row && readStructuredMailSendRow(row)
}

export function getStructuredMailSendMailboxes(this: OrchestrationDb): string[] {
  return this.db
    .prepare('SELECT DISTINCT mailbox_handle FROM structured_mail_sends')
    .all()
    .flatMap(({ mailbox_handle }) => (typeof mailbox_handle === 'string' ? [mailbox_handle] : []))
}

/** Reserve a send before the host call: its record and the message's delivered stamp land together,
 *  so no crash between the send and its bookkeeping leaves the message selectable again. The message
 *  stays unread. `replacing` swaps one attempt for the next only while it is still the current one,
 *  so two passes that both saw it fail cannot both send it again. False when another pass holds it. */
export function reserveStructuredMailSend(
  this: OrchestrationDb,
  row: StructuredMailSendRow,
  replacing?: string
): boolean {
  return runLifecycleWriteTransaction(this.db, 'reserve_structured_mail_send', () => {
    const reserved =
      replacing === undefined
        ? this.db
            .prepare(
              `INSERT INTO structured_mail_sends
                 (mailbox_handle, message_id, session_id, operation_id, minted_at_ms)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(mailbox_handle, message_id) DO NOTHING`
            )
            .run(
              row.mailbox_handle,
              row.message_id,
              row.session_id,
              row.operation_id,
              row.minted_at_ms
            ).changes === 1
        : this.db
            .prepare(
              `UPDATE structured_mail_sends
                  SET session_id = ?, operation_id = ?, minted_at_ms = ?
                WHERE mailbox_handle = ? AND message_id = ? AND operation_id = ?`
            )
            .run(
              row.session_id,
              row.operation_id,
              row.minted_at_ms,
              row.mailbox_handle,
              row.message_id,
              replacing
            ).changes === 1
    if (reserved) {
      this.markAsDelivered([row.message_id], row.mailbox_handle)
    }
    return reserved
  })
}

function deleteCurrentAttempt(db: OrchestrationDb, row: StructuredMailSendRow): boolean {
  return (
    db.db
      .prepare(
        `DELETE FROM structured_mail_sends
          WHERE mailbox_handle = ? AND message_id = ? AND operation_id = ?`
      )
      .run(row.mailbox_handle, row.message_id, row.operation_id).changes === 1
  )
}

/** Nothing reached the chat under this attempt: drop it and its reservation, so mail still unread is
 *  selected again by whoever owns the mailbox then. A newer attempt is left alone. */
export function releaseStructuredMailSend(
  this: OrchestrationDb,
  row: StructuredMailSendRow
): boolean {
  return runLifecycleWriteTransaction(this.db, 'release_structured_mail_send', () => {
    const released = deleteCurrentAttempt(this, row)
    if (released) {
      this.markAsUndelivered([row.message_id])
    }
    return released
  })
}

/** The chat's part is over: drop the attempt, stamping what it ended as in the same write. A record
 *  saved before reservations carries no delivered stamp; this repairs it before it goes, so the message
 *  is never selectable again. `consumed`: the agent or the person took it whole, so it is read too. */
export function retireStructuredMailSend(
  this: OrchestrationDb,
  row: StructuredMailSendRow,
  consumed: boolean
): boolean {
  return runLifecycleWriteTransaction(this.db, 'retire_structured_mail_send', () => {
    const retired = deleteCurrentAttempt(this, row)
    if (retired && consumed) {
      this.markAsReadAndDelivered([row.message_id])
    } else if (retired) {
      this.db
        .prepare(
          `UPDATE messages SET delivered_at = COALESCE(delivered_at, datetime('now'))
            WHERE id = ? AND to_handle = ?`
        )
        .run(row.message_id, row.mailbox_handle)
    }
    return retired
  })
}

export type StructuredMailSendStoreMethods = {
  getStructuredMailSends: typeof getStructuredMailSends
  getStructuredMailSend: typeof getStructuredMailSend
  getStructuredMailSendMailboxes: typeof getStructuredMailSendMailboxes
  reserveStructuredMailSend: typeof reserveStructuredMailSend
  releaseStructuredMailSend: typeof releaseStructuredMailSend
  retireStructuredMailSend: typeof retireStructuredMailSend
}

export function attachStructuredMailSendStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getStructuredMailSends,
    getStructuredMailSend,
    getStructuredMailSendMailboxes,
    reserveStructuredMailSend,
    releaseStructuredMailSend,
    retireStructuredMailSend
  })
}
