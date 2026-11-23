import type {
  MessageType,
  MessagePriority,
  MessageDeliveryContract,
  MessageRow
} from '../orchestration-records'
import { generateId } from '../generated-id'
import { exposeMessageTimestamps } from '../utc-timestamp'
import type { OrchestrationDb } from '../orchestration-db'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import { notifyPeerMailQueued } from '../../federation/peer-mail/peer-mail-waiters'
import { ORCHESTRATION_UNBOUND_RUN_ID as UNBOUND_RUN_ID } from '../../../../../shared/orchestration/orchestration-rpc-contract'
import { MESSAGE_COLUMN_LIST } from '../row-column-lists'
import { callerMailProvenance, type OrcaAuthoredMail } from './message-orca-provenance'
import { recordMessageSenderDispatch } from './message-sender-dispatch'
import { recordMessageWorkTargetProvenance } from './message-work-target-provenance'
import type { ResolvedBotWorkTargetPlacement } from '../../../../../shared/agent-session/work-target/agent-session-work-target'

const MESSAGE_INSERT_SAVEPOINT = 'message_insert_batch'
const MESSAGE_PROVENANCE_SAVEPOINT = 'message_work_target_provenance_insert'
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
  answerSenderSnapshot?: string
  deliveryContract?: MessageDeliveryContract
  /** The Dispatch whose worker sent this, as the sender's own check found it; names it on every card. */
  senderDispatchId?: string
  /** Orca wrote this mail itself, so its payload (and for item mail its sender) stands. */
  orcaAuthored?: OrcaAuthoredMail
  /** Host-authored work target active when this follow-up message was accepted; persisted atomically. */
  workTargetProvenance?: {
    sourceOrigin: string
    placement: ResolvedBotWorkTargetPlacement
  }
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
  const payload = callerMailProvenance(msg)
  const deliveryContract = msg.deliveryContract ?? 'current_delivery'
  this.requireRun(runId)
  const id = msg.id ?? generateId('msg')
  const type = msg.type ?? 'status'
  const writeMessage = (): void => {
    // A heartbeat is never shown, so it names no one. Before the insert, whose trigger queues a peer Run's mail home with it.
    if (msg.senderDispatchId && type !== 'heartbeat') {
      recordMessageSenderDispatch(this, id, msg.senderDispatchId)
    }
    if (msg.workTargetProvenance) {
      recordMessageWorkTargetProvenance(
        this,
        id,
        msg.workTargetProvenance.sourceOrigin,
        msg.workTargetProvenance.placement
      )
    }
    // Heartbeats only record liveness: store them handled so they never reach a mailbox or wake it.
    const handled = type === 'heartbeat' ? 1 : 0
    const stmt = this.db.prepare(`
      INSERT INTO messages (
        id, run_id, delivery_contract, from_handle, to_handle, subject, body,
        type, priority, thread_id, payload, sender_pane_key, answer_sender_snapshot, read, delivered_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN datetime('now') END)
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
      payload ?? null,
      msg.senderPaneKey ?? null,
      msg.answerSenderSnapshot ?? null,
      handled,
      handled
    )
  }
  if (msg.workTargetProvenance) {
    this.db.exec(`SAVEPOINT ${MESSAGE_PROVENANCE_SAVEPOINT}`)
    try {
      writeMessage()
      this.db.exec(`RELEASE ${MESSAGE_PROVENANCE_SAVEPOINT}`)
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${MESSAGE_PROVENANCE_SAVEPOINT}`)
      this.db.exec(`RELEASE ${MESSAGE_PROVENANCE_SAVEPOINT}`)
      throw error
    }
  } else {
    writeMessage()
  }
  // Mail filed in a peer Run is queued home by trigger in this statement.
  notifyPeerMailQueued(this.db)
  return exposeMessageTimestamps(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the column list names every column of the row type, and a missing one fails compilation.
    this.db
      .prepare(`SELECT ${MESSAGE_COLUMN_LIST} FROM messages WHERE id = ?`)
      .get(id) as MessageRow
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
