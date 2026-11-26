import type { OrchestrationDb } from '../orchestration-db'
import { recordRemoteStart } from './remote-placements'

/** The Dispatch a start's receipt names: its result once it ran, or the one it accepted while pending. */
function receiptDispatchId(receipt: unknown): string | undefined {
  if (!receipt || typeof receipt !== 'object') {
    return undefined
  }
  if ('dispatchId' in receipt && typeof receipt.dispatchId === 'string') {
    return receipt.dispatchId
  }
  const accepted = 'accepted' in receipt ? receipt.accepted : undefined
  return accepted &&
    typeof accepted === 'object' &&
    'dispatchId' in accepted &&
    typeof accepted.dispatchId === 'string'
    ? accepted.dispatchId
    : undefined
}

/** A server's answer to this Orca's receipt lookup for one of its own `--on` starts records the
 *  Dispatch it names, as the start's lost answer would have. Anything else records nothing. */
export function recordRemoteStartReceipt(
  db: OrchestrationDb,
  requestKey: string,
  answer: unknown
): void {
  const dispatchId =
    answer &&
    typeof answer === 'object' &&
    'requestId' in answer &&
    answer.requestId === requestKey &&
    'method' in answer &&
    answer.method === 'orchestration.workerStart' &&
    'receipt' in answer
      ? receiptDispatchId(answer.receipt)
      : undefined
  const placement: unknown = dispatchId
    ? db.db
        .prepare('SELECT task_id, conversation_id FROM remote_placements WHERE request_key = ?')
        .get(requestKey)
    : undefined
  if (
    !dispatchId ||
    !placement ||
    typeof placement !== 'object' ||
    !('task_id' in placement) ||
    typeof placement.task_id !== 'string' ||
    !('conversation_id' in placement) ||
    typeof placement.conversation_id !== 'string'
  ) {
    return
  }
  try {
    recordRemoteStart(db, {
      conversationId: placement.conversation_id,
      taskId: placement.task_id,
      dispatchId,
      requestKey
    })
  } catch (error) {
    // The lookup still answers; the attempt's queue adopts it as before.
    console.warn('[orchestration] recording a server start receipt failed', dispatchId, error)
  }
}
