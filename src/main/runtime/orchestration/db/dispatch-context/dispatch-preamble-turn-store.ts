import type { OrchestrationDb } from '../orchestration-db'
import type { StructuredPointerOperationRow } from '../messages/structured-pointer-operation-store'

/**
 * A chat assignee's dispatch preamble, owed as its next turn: one row per Dispatch, never in
 * `messages`, so no mail reader, count or attention query can see it. Whether it may still be sent
 * is derived from its Dispatch's status, never from this row; the row only records how far its one
 * send got:
 * - `owed`: not sent, or refused for certain (the chat never got it).
 * - `sending`: a send is in flight.
 * - `in_doubt`: a send whose outcome is not known; it may have reached the chat.
 * - `delivered`: the chat's provider accepted it as a turn.
 */
export type DispatchPreambleTurnState = 'owed' | 'sending' | 'in_doubt' | 'delivered'

export type DispatchPreambleTurnRow = {
  dispatch_id: string
  body: string
  state: DispatchPreambleTurnState
  /** The live operation id of its send, as the mail ledger keeps one per mailbox; null unsent. */
  session_id: string | null
  operation_id: string | null
  batch_fingerprint: string | null
  minted_at_ms: number | null
}

export function putDispatchPreambleTurn(
  this: OrchestrationDb,
  dispatchId: string,
  body: string
): void {
  this.db
    .prepare(
      `INSERT INTO dispatch_preamble_turns (dispatch_id, body, state) VALUES (?, ?, 'owed')
       ON CONFLICT(dispatch_id) DO NOTHING`
    )
    .run(dispatchId, body)
}

export function getDispatchPreambleTurn(
  this: OrchestrationDb,
  dispatchId: string
): DispatchPreambleTurnRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SELECT names exactly the row's columns.
  return this.db
    .prepare(
      `SELECT dispatch_id, body, state, session_id, operation_id, batch_fingerprint, minted_at_ms
         FROM dispatch_preamble_turns WHERE dispatch_id = ?`
    )
    .get(dispatchId) as DispatchPreambleTurnRow | undefined
}

/**
 * Starts the one send: false when the turn was withdrawn or delivered. The lane sends a mailbox one
 * attempt at a time, so a `sending` row it reaches is one a process that died left behind.
 */
export function claimDispatchPreambleTurnSend(this: OrchestrationDb, dispatchId: string): boolean {
  return (
    this.db
      .prepare(
        `UPDATE dispatch_preamble_turns SET state = 'sending'
          WHERE dispatch_id = ? AND state != 'delivered'`
      )
      .run(dispatchId).changes === 1
  )
}

export function settleDispatchPreambleTurnSend(
  this: OrchestrationDb,
  dispatchId: string,
  state: Exclude<DispatchPreambleTurnState, 'sending'>
): void {
  this.db
    .prepare('UPDATE dispatch_preamble_turns SET state = ? WHERE dispatch_id = ?')
    .run(state, dispatchId)
}

/** Mints the send's operation id onto the row; a row already gone or delivered keeps nothing. */
export function recordDispatchPreambleTurnOperation(
  this: OrchestrationDb,
  dispatchId: string,
  operation: Omit<StructuredPointerOperationRow, 'mailbox_handle'>
): void {
  this.db
    .prepare(
      `UPDATE dispatch_preamble_turns
          SET session_id = ?, operation_id = ?, batch_fingerprint = ?, minted_at_ms = ?
        WHERE dispatch_id = ? AND state != 'delivered'`
    )
    .run(
      operation.session_id,
      operation.operation_id,
      operation.batch_fingerprint,
      operation.minted_at_ms,
      dispatchId
    )
}

/** Dispatch mailboxes whose active Dispatch still owes its chat the preamble. */
export function getOwedDispatchPreambleMailboxes(this: OrchestrationDb): string[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SELECT names exactly this column.
  const rows = this.db
    .prepare(
      `SELECT turn.dispatch_id AS id FROM dispatch_preamble_turns turn
         JOIN dispatch_contexts dispatch ON dispatch.id = turn.dispatch_id
        WHERE turn.state != 'delivered' AND dispatch.status IN ('pending', 'dispatched')`
    )
    .all() as { id: string }[]
  return rows.map((row) => `dispatch:${row.id}`)
}

export type DispatchPreambleTurnStoreMethods = {
  putDispatchPreambleTurn: typeof putDispatchPreambleTurn
  getDispatchPreambleTurn: typeof getDispatchPreambleTurn
  claimDispatchPreambleTurnSend: typeof claimDispatchPreambleTurnSend
  settleDispatchPreambleTurnSend: typeof settleDispatchPreambleTurnSend
  recordDispatchPreambleTurnOperation: typeof recordDispatchPreambleTurnOperation
  getOwedDispatchPreambleMailboxes: typeof getOwedDispatchPreambleMailboxes
}

export function attachDispatchPreambleTurnStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    putDispatchPreambleTurn,
    getDispatchPreambleTurn,
    claimDispatchPreambleTurnSend,
    settleDispatchPreambleTurnSend,
    recordDispatchPreambleTurnOperation,
    getOwedDispatchPreambleMailboxes
  })
}
