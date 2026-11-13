import type { OrchestrationDb } from '../orchestration-db'
import { OrchestrationError } from '../../orchestration-error'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'

export const MUTATION_RECEIPT_FULL_REPLAY_MINUTES = 15

type ReceiptObject = Record<string, unknown>
type CompactedMessage = ReceiptObject & { id: string }

const isReceiptObject = (value: unknown): value is ReceiptObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const embeddedMessages = (method: string, receipt: ReceiptObject): unknown[] | undefined => {
  if (method === 'orchestration.check') {
    return Array.isArray(receipt.messages) ? receipt.messages : undefined
  }
  return method === 'orchestration.reply' && isReceiptObject(receipt.message)
    ? [receipt.message]
    : undefined
}

const sameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

// Only the fields the stored row repeats go; receipt-only fields such as a report follow-up stay.
function compactMessage(
  message: unknown,
  storedMessage: (messageId: string) => ReceiptObject | undefined
): CompactedMessage | undefined {
  if (!isReceiptObject(message) || typeof message.id !== 'string') {
    return undefined
  }
  const stored = storedMessage(message.id)
  if (!stored || !sameValue(stored.body, message.body)) {
    return undefined
  }
  const kept = Object.entries(message).filter(
    ([key, value]) => key === 'id' || !(key in stored) || !sameValue(stored[key], value)
  )
  return { ...Object.fromEntries(kept), id: message.id }
}

/**
 * The receipt with each embedded message reduced to the fields its stored row does not repeat, or
 * undefined when a message is not stored here with the same body, since replay rebuilds from it.
 */
export function compactMutationReceipt(
  method: string,
  receipt: unknown,
  storedMessage: (messageId: string) => ReceiptObject | undefined
): ReceiptObject | undefined {
  if (!isReceiptObject(receipt)) {
    return undefined
  }
  const embedded = embeddedMessages(method, receipt) ?? []
  const messages = embedded.flatMap((message) => compactMessage(message, storedMessage) ?? [])
  if (messages.length !== embedded.length || embedded.length === 0) {
    return undefined
  }
  const compacted: ReceiptObject = { ...receipt }
  if (method === 'orchestration.check') {
    delete compacted.messages
    return { ...compacted, compactedMessages: messages }
  }
  delete compacted.message
  const { question } = receipt
  const replied = receipt.message
  if (
    isReceiptObject(question) &&
    isReceiptObject(replied) &&
    sameValue(question.answer_body, replied.body)
  ) {
    const compactedQuestion = { ...question }
    delete compactedQuestion.answer_body
    compacted.question = compactedQuestion
  }
  const [compactedMessage] = messages
  return { ...compacted, compactedMessage }
}

/** Rebuilds a compacted receipt's messages; a message deleted since cannot be replayed. */
export function expandCompactedMutationReceipt(
  receipt: unknown,
  requestId: string,
  loadMessage: (messageId: string) => ReceiptObject | undefined
): unknown {
  if (!isReceiptObject(receipt)) {
    return receipt
  }
  const { compactedMessages, compactedMessage } = receipt
  const compacted = Array.isArray(compactedMessages)
    ? compactedMessages
    : isReceiptObject(compactedMessage)
      ? [compactedMessage]
      : undefined
  if (!compacted) {
    return receipt
  }
  const messages = compacted.map((message) => {
    const loaded =
      isReceiptObject(message) && typeof message.id === 'string'
        ? loadMessage(message.id)
        : undefined
    if (!loaded || !isReceiptObject(message)) {
      throw new OrchestrationError(
        'operation_unknown',
        `Mutation ${requestId} completed, but a message in its result is gone, so it cannot be replayed.`,
        { requestId }
      )
    }
    return { ...loaded, ...message }
  })
  const expanded: ReceiptObject = { ...receipt }
  delete expanded.compactedMessages
  delete expanded.compactedMessage
  if (Array.isArray(compactedMessages)) {
    return { ...expanded, messages }
  }
  const [message] = messages
  const { question } = receipt
  return {
    ...expanded,
    message,
    ...(isReceiptObject(question) && !('answer_body' in question)
      ? { question: { ...question, answer_body: message?.body } }
      : {})
  }
}

/**
 * Compacts up to `limit` check and reply receipts completed before the full replay window, in
 * rowid order after `afterRowid`. Returns the last rowid it read and how many rows it read.
 */
export function compactMutationReceipts(
  this: OrchestrationDb,
  afterRowid: number,
  limit: number
): { lastRowid: number; read: number } {
  return runLifecycleWriteTransaction(this.db, 'mutation_receipt_compaction', () => {
    const rows = this.db
      .prepare(
        `SELECT rowid, method, receipt FROM mutation_receipts
         WHERE rowid > ? AND state = 'completed'
           AND method IN ('orchestration.check', 'orchestration.reply')
           AND julianday(updated_at) <= julianday('now', ?)
           AND CASE WHEN json_valid(receipt)
             THEN json_type(receipt, '$.messages') = 'array'
               OR json_type(receipt, '$.message') = 'object'
             ELSE 0 END
         ORDER BY rowid LIMIT ?`
      )
      .all(afterRowid, `-${MUTATION_RECEIPT_FULL_REPLAY_MINUTES} minutes`, limit)
    const update = this.db.prepare('UPDATE mutation_receipts SET receipt = ? WHERE rowid = ?')
    for (const row of rows) {
      const compacted = compactMutationReceipt(
        String(row.method),
        JSON.parse(String(row.receipt)),
        (messageId) => this.getMessageById(messageId)
      )
      if (compacted) {
        update.run(JSON.stringify(compacted), Number(row.rowid))
      }
    }
    return { lastRowid: Number(rows.at(-1)?.rowid ?? afterRowid), read: rows.length }
  })
}
