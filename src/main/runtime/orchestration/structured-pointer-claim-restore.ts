/**
 * Gives back structured pointer claims an earlier process left open.
 *
 * A pointer the host admits as `pending` stamps its batch delivered, and an in-memory settlement
 * waiter either keeps that (the turn ran) or gives it back, then drops the durable operation row.
 * A row that is still here when the database opens was minted by an earlier process: its waiter
 * died with it, and a restart settles its unechoed send without a turn, so nothing would ever give
 * the batch back. The claim belongs to the process that made it, as a PTY pointer's belongs to its
 * pane's process, and it is released on that mismatch so the mailbox is pointed again.
 *
 * The batch is found by the row's fingerprint among the mailbox's stamped, unread rows; one
 * statement stamped it, so it shares one `delivered_at`. A row whose batch was never stamped (its
 * send was never admitted) is left alone: its id is the idempotency key the retry reuses.
 */

import type { OrchestrationDb } from './db'
import type { StructuredPointerOperationRow } from './db/messages/structured-pointer-operation-store'
import { structuredPointerBatchFingerprint } from './structured-pointer-operation-id'

/** Run when the database opens; returns the mailboxes whose claim was released. */
export function releaseRestoredStructuredPointerClaims(db: OrchestrationDb | null): string[] {
  // A partial test double may lack the store.
  if (!db?.listStructuredPointerOperations) {
    return []
  }
  const released: string[] = []
  try {
    for (const operation of db.listStructuredPointerOperations()) {
      const batch = stampedBatch(db.getPointedUnreadMessages(operation.mailbox_handle), operation)
      if (batch) {
        db.markAsUndelivered(batch)
        db.deleteStructuredPointerOperation(operation.mailbox_handle)
        released.push(operation.mailbox_handle)
      }
    }
  } catch (error) {
    console.warn('[orchestration] failed to release restored structured pointer claims', error)
  }
  if (released.length > 0) {
    console.info('[orchestration] released structured pointer claims left by an earlier run', {
      mailboxes: released.length
    })
  }
  return released
}

function stampedBatch(
  pointed: readonly { id: string; delivered_at: string }[],
  operation: StructuredPointerOperationRow
): string[] | null {
  const byStamp = new Map<string, string[]>()
  for (const row of pointed) {
    byStamp.set(row.delivered_at, [...(byStamp.get(row.delivered_at) ?? []), row.id])
  }
  for (const ids of byStamp.values()) {
    // An earlier batch stamped in the same second shares the stamp and sorts first.
    for (let start = 0; start < ids.length; start += 1) {
      const candidate = ids.slice(start)
      if (
        structuredPointerBatchFingerprint(operation.session_id, candidate) ===
        operation.batch_fingerprint
      ) {
        return candidate
      }
    }
  }
  return null
}
