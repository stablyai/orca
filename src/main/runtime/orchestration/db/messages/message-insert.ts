import type { MessageType, MessagePriority, MessageDeliveryContract, MessageRow } from '../../types'
import { LEGACY_RUN_ID } from '../contract-constants'
import { generateId } from '../generated-id'
import { exposeMessageTimestamps } from '../utc-timestamp'
import type { OrchestrationDb } from '../orchestration-db'

// ── Messages ──

export function insertMessage(
  this: OrchestrationDb,
  msg: {
    id?: string
    from: string
    to: string
    subject: string
    body?: string
    type?: MessageType
    priority?: MessagePriority
    threadId?: string
    payload?: string
    senderPaneKey?: string
    runId?: string
    deliveryContract?: MessageDeliveryContract
  }
): MessageRow {
  const runId = msg.runId ?? LEGACY_RUN_ID
  const deliveryContract = msg.deliveryContract ?? 'current_delivery'
  this.requireRun(runId)
  const id = msg.id ?? generateId('msg')
  const stmt = this.db.prepare(`
    INSERT INTO messages (
      id, run_id, delivery_contract, from_handle, to_handle, subject, body,
      type, priority, thread_id, payload, sender_pane_key
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(
    id,
    runId,
    deliveryContract,
    msg.from,
    msg.to,
    msg.subject,
    msg.body ?? '',
    msg.type ?? 'status',
    msg.priority ?? 'normal',
    msg.threadId ?? null,
    msg.payload ?? null,
    msg.senderPaneKey ?? null
  )
  return exposeMessageTimestamps(
    this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow
  )
}

export type MessageInsertMethods = {
  insertMessage: typeof insertMessage
}

export function attachMessageInsert(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    insertMessage
  })
}
