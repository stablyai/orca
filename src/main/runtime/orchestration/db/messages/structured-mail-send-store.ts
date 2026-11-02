import type { OrchestrationDb } from '../orchestration-db'

/** One orchestration message handed to a chat session: the agent-session operation id its send used. */
export type StructuredMailSendRow = {
  mailbox_handle: string
  message_id: string
  session_id: string
  operation_id: string
  minted_at_ms: number
  /** The session's fence when it was sent: a context cleared since then never took it. */
  fence: number
}

export function getStructuredMailSends(
  this: OrchestrationDb,
  mailboxHandle: string
): StructuredMailSendRow[] {
  return this.db
    .prepare('SELECT * FROM structured_mail_sends WHERE mailbox_handle = ? ORDER BY minted_at_ms')
    .all(mailboxHandle) as StructuredMailSendRow[]
}

export function getStructuredMailSend(
  this: OrchestrationDb,
  mailboxHandle: string,
  messageId: string
): StructuredMailSendRow | undefined {
  return this.db
    .prepare('SELECT * FROM structured_mail_sends WHERE mailbox_handle = ? AND message_id = ?')
    .get(mailboxHandle, messageId) as StructuredMailSendRow | undefined
}

export function getStructuredMailSendMailboxes(this: OrchestrationDb): string[] {
  return (
    this.db.prepare('SELECT DISTINCT mailbox_handle FROM structured_mail_sends').all() as {
      mailbox_handle: string
    }[]
  ).map((row) => row.mailbox_handle)
}

/** Record a first send; false when another pass already holds this message's send. */
export function putStructuredMailSend(this: OrchestrationDb, row: StructuredMailSendRow): boolean {
  return (
    this.db
      .prepare(
        `INSERT INTO structured_mail_sends
           (mailbox_handle, message_id, session_id, operation_id, minted_at_ms, fence)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(mailbox_handle, message_id) DO NOTHING`
      )
      .run(
        row.mailbox_handle,
        row.message_id,
        row.session_id,
        row.operation_id,
        row.minted_at_ms,
        row.fence
      ).changes === 1
  )
}

/** Swap one attempt for the next only if it is still the current one, so two passes that both saw it
 *  fail cannot both send it again. */
export function replaceStructuredMailSendAttempt(
  this: OrchestrationDb,
  expectedOperationId: string,
  next: StructuredMailSendRow
): boolean {
  return (
    this.db
      .prepare(
        `UPDATE structured_mail_sends
            SET session_id = ?, operation_id = ?, minted_at_ms = ?, fence = ?
          WHERE mailbox_handle = ? AND message_id = ? AND operation_id = ?`
      )
      .run(
        next.session_id,
        next.operation_id,
        next.minted_at_ms,
        next.fence,
        next.mailbox_handle,
        next.message_id,
        expectedOperationId
      ).changes === 1
  )
}

export function deleteStructuredMailSend(
  this: OrchestrationDb,
  mailboxHandle: string,
  messageId: string
): void {
  this.db
    .prepare('DELETE FROM structured_mail_sends WHERE mailbox_handle = ? AND message_id = ?')
    .run(mailboxHandle, messageId)
}

export type StructuredMailSendStoreMethods = {
  getStructuredMailSends: typeof getStructuredMailSends
  getStructuredMailSend: typeof getStructuredMailSend
  getStructuredMailSendMailboxes: typeof getStructuredMailSendMailboxes
  putStructuredMailSend: typeof putStructuredMailSend
  replaceStructuredMailSendAttempt: typeof replaceStructuredMailSendAttempt
  deleteStructuredMailSend: typeof deleteStructuredMailSend
}

export function attachStructuredMailSendStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getStructuredMailSends,
    getStructuredMailSend,
    getStructuredMailSendMailboxes,
    putStructuredMailSend,
    replaceStructuredMailSendAttempt,
    deleteStructuredMailSend
  })
}
