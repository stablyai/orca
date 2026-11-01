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

export function getStructuredMailSendMailboxes(this: OrchestrationDb): string[] {
  return (
    this.db.prepare('SELECT DISTINCT mailbox_handle FROM structured_mail_sends').all() as {
      mailbox_handle: string
    }[]
  ).map((row) => row.mailbox_handle)
}

/** Sends whose message a check consumed or a move re-addressed while it still waited in the chat. */
export function getTakenStructuredMailSends(this: OrchestrationDb): StructuredMailSendRow[] {
  return this.db
    .prepare(
      `SELECT s.* FROM structured_mail_sends s
       LEFT JOIN messages m ON m.id = s.message_id
       WHERE m.id IS NULL OR m.read = 1 OR m.to_handle <> s.mailbox_handle`
    )
    .all() as StructuredMailSendRow[]
}

export function putStructuredMailSend(this: OrchestrationDb, row: StructuredMailSendRow): void {
  this.db
    .prepare(
      `INSERT INTO structured_mail_sends
         (mailbox_handle, message_id, session_id, operation_id, minted_at_ms, fence)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(mailbox_handle, message_id) DO UPDATE SET
         session_id = excluded.session_id, operation_id = excluded.operation_id,
         minted_at_ms = excluded.minted_at_ms, fence = excluded.fence`
    )
    .run(
      row.mailbox_handle,
      row.message_id,
      row.session_id,
      row.operation_id,
      row.minted_at_ms,
      row.fence
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
  getStructuredMailSendMailboxes: typeof getStructuredMailSendMailboxes
  getTakenStructuredMailSends: typeof getTakenStructuredMailSends
  putStructuredMailSend: typeof putStructuredMailSend
  deleteStructuredMailSend: typeof deleteStructuredMailSend
}

export function attachStructuredMailSendStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getStructuredMailSends,
    getStructuredMailSendMailboxes,
    getTakenStructuredMailSends,
    putStructuredMailSend,
    deleteStructuredMailSend
  })
}
