import type { MessageType, MessagePriority, MessageDeliveryContract, MessageRow } from '../../types'
import { generateId } from '../generated-id'
import { exposeMessageTimestamps } from '../utc-timestamp'
import type { OrchestrationDb } from '../orchestration-db'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import { UNBOUND_RUN_ID } from '../contract-constants'

const MESSAGE_INSERT_SAVEPOINT = 'message_insert_batch'
const WORKER_DONE_MESSAGE_SAVEPOINT = 'worker_done_message_commit'

export type MessageInsert = {
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

export function insertMessage(this: OrchestrationDb, msg: MessageInsert): MessageRow {
  // Unbound senders get a lazily created unbound Run; the legacy Run denotes pre-Runs data to skew probes.
  const runId = msg.runId ?? UNBOUND_RUN_ID
  if (msg.runId == null) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO runs (id, objective, home_database, consumer_generation, legacy)
         VALUES (?, 'Mail from terminals in no Run', 'this_database', 0, 0)`
      )
      .run(UNBOUND_RUN_ID)
  }
  const deliveryContract = msg.deliveryContract ?? 'current_delivery'
  this.requireRun(runId)
  const id = msg.id ?? generateId('msg')
  const type = msg.type ?? 'status'
  // Heartbeats only record liveness: store them handled so they never reach a mailbox or wake it.
  const handled = type === 'heartbeat' ? 1 : 0
  const stmt = this.db.prepare(`
    INSERT INTO messages (
      id, run_id, delivery_contract, from_handle, to_handle, subject, body,
      type, priority, thread_id, payload, sender_pane_key, read, delivered_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN datetime('now') END)
  `)
  stmt.run(
    id,
    runId,
    deliveryContract,
    msg.from,
    msg.to,
    msg.subject,
    msg.body ?? '',
    type,
    msg.priority ?? 'normal',
    msg.threadId ?? null,
    msg.payload ?? null,
    msg.senderPaneKey ?? null,
    handled,
    handled
  )
  return exposeMessageTimestamps(
    this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow
  )
}

export function insertMessages(this: OrchestrationDb, messages: MessageInsert[]): MessageRow[] {
  this.db.exec(`SAVEPOINT ${MESSAGE_INSERT_SAVEPOINT}`)
  try {
    const inserted = messages.map((message) => this.insertMessage(message))
    this.db.exec(`RELEASE ${MESSAGE_INSERT_SAVEPOINT}`)
    return inserted
  } catch (error) {
    this.db.exec(`ROLLBACK TO ${MESSAGE_INSERT_SAVEPOINT}`)
    this.db.exec(`RELEASE ${MESSAGE_INSERT_SAVEPOINT}`)
    throw error
  }
}

export function commitWorkerDoneMessageMutation<T>(this: OrchestrationDb, mutation: () => T): T {
  return runLifecycleWriteTransaction(this.db, WORKER_DONE_MESSAGE_SAVEPOINT, mutation)
}

export type MessageInsertMethods = {
  insertMessage: typeof insertMessage
  insertMessages: typeof insertMessages
  commitWorkerDoneMessageMutation: typeof commitWorkerDoneMessageMutation
}

export function attachMessageInsert(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    insertMessage,
    insertMessages,
    commitWorkerDoneMessageMutation
  })
}
