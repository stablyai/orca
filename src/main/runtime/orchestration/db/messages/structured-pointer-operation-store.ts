import type { OrchestrationDb } from '../orchestration-db'

/** The live agent-session operation id backing one structured worker mailbox's pointer send. */
export type StructuredPointerOperationRow = {
  mailbox_handle: string
  session_id: string
  operation_id: string
  batch_fingerprint: string
  minted_at_ms: number
}

export function getStructuredPointerOperation(
  this: OrchestrationDb,
  mailboxHandle: string
): StructuredPointerOperationRow | undefined {
  return this.db
    .prepare('SELECT * FROM structured_pointer_operations WHERE mailbox_handle = ?')
    .get(mailboxHandle) as StructuredPointerOperationRow | undefined
}

export function putStructuredPointerOperation(
  this: OrchestrationDb,
  row: StructuredPointerOperationRow
): void {
  this.db
    .prepare(
      `INSERT INTO structured_pointer_operations
         (mailbox_handle, session_id, operation_id, batch_fingerprint, minted_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(mailbox_handle) DO UPDATE SET
         session_id = excluded.session_id, operation_id = excluded.operation_id,
         batch_fingerprint = excluded.batch_fingerprint, minted_at_ms = excluded.minted_at_ms`
    )
    .run(
      row.mailbox_handle,
      row.session_id,
      row.operation_id,
      row.batch_fingerprint,
      row.minted_at_ms
    )
}

export function deleteStructuredPointerOperation(
  this: OrchestrationDb,
  mailboxHandle: string
): void {
  this.db
    .prepare('DELETE FROM structured_pointer_operations WHERE mailbox_handle = ?')
    .run(mailboxHandle)
}

export function listStructuredPointerOperations(
  this: OrchestrationDb
): StructuredPointerOperationRow[] {
  const rows = this.db.prepare('SELECT * FROM structured_pointer_operations').all()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table returns the row shape its schema and row type define, like every row cast in db/.
  return rows as StructuredPointerOperationRow[]
}

/** Unread rows a pointer was sent for, in the order a pointer batch lists them. */
export function getPointedUnreadMessages(
  this: OrchestrationDb,
  mailboxHandle: string
): { id: string; delivered_at: string }[] {
  const rows = this.db
    .prepare(
      `SELECT id, delivered_at FROM messages
       WHERE to_handle = ? AND read = 0 AND delivered_at IS NOT NULL
         AND delivery_contract = 'current_delivery'
       ORDER BY sequence`
    )
    .all(mailboxHandle)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both columns are TEXT and the WHERE clause excludes a NULL `delivered_at`.
  return rows as { id: string; delivered_at: string }[]
}

export type StructuredPointerOperationStoreMethods = {
  listStructuredPointerOperations: typeof listStructuredPointerOperations
  getPointedUnreadMessages: typeof getPointedUnreadMessages
  getStructuredPointerOperation: typeof getStructuredPointerOperation
  putStructuredPointerOperation: typeof putStructuredPointerOperation
  deleteStructuredPointerOperation: typeof deleteStructuredPointerOperation
}

export function attachStructuredPointerOperationStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    listStructuredPointerOperations,
    getPointedUnreadMessages,
    getStructuredPointerOperation,
    putStructuredPointerOperation,
    deleteStructuredPointerOperation
  })
}
