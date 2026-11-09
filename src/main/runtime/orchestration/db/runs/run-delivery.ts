import type { MessageType, MessageRow, RunRow, DeliveryRow } from '../orchestration-records'
import { OrchestrationError } from '../../orchestration-error'
import { exposeMessageListTimestamps } from '../utc-timestamp'
import type { OrchestrationDb } from '../orchestration-db'
import type { MailboxDeliveryBatch } from '../messages/role-mailbox-delivery'

export function requireCurrentConsumer(
  this: OrchestrationDb,
  runId: string,
  consumerGeneration: number
): RunRow {
  const run = this.getRunRaw(runId)
  if (!run || run.legacy === 1 || run.consumer_generation !== consumerGeneration) {
    throw new OrchestrationError(
      'consumer_fenced',
      `Another session now coordinates Run ${runId}; stop reading this mailbox.`
    )
  }
  return run
}

export function getOrCreateRunDelivery(
  this: OrchestrationDb,
  params: {
    runId: string
    consumerGeneration: number
    limit?: number
    wakeTypes?: MessageType[]
  }
): { delivery: DeliveryRow; messages: MessageRow[]; replayed: boolean } | undefined {
  return this.getOrCreateMailboxDelivery({
    runId: params.runId,
    mailboxHandle: `run:${params.runId}`,
    consumerGeneration: params.consumerGeneration,
    limit: params.limit,
    wakeTypes: params.wakeTypes
  })
}

export function takeRunDelivery(
  this: OrchestrationDb,
  params: {
    runId: string
    consumerGeneration: number
    wakeTypes?: MessageType[]
    recordTaken?: (batch: MailboxDeliveryBatch) => void
  }
): MailboxDeliveryBatch | undefined {
  return this.takeMailboxDelivery({ ...params, mailboxHandle: `run:${params.runId}` })
}

export function acknowledgeRunDelivery(
  this: OrchestrationDb,
  params: {
    runId: string
    consumerGeneration: number
    deliveryId: string
  }
): { delivery: DeliveryRow; duplicate: boolean } {
  return this.acknowledgeMailboxDelivery({
    runId: params.runId,
    mailboxHandle: `run:${params.runId}`,
    consumerGeneration: params.consumerGeneration,
    deliveryId: params.deliveryId
  })
}

export function getRunMailboxHistory(
  this: OrchestrationDb,
  runId: string,
  limit = 100,
  types?: MessageType[]
): MessageRow[] {
  const address = `run:${runId}`
  // SQLite treats negative LIMIT as unbounded; clamp it to avoid dumping the mailbox.
  const rowLimit = Math.max(1, Math.floor(limit))
  if (types && types.length > 0) {
    const placeholders = types.map(() => '?').join(',')
    return exposeMessageListTimestamps(
      this.db
        .prepare(
          `SELECT * FROM messages WHERE run_id = ? AND to_handle = ?
           AND type IN (${placeholders}) ORDER BY sequence DESC LIMIT ?`
        )
        .all(runId, address, ...types, rowLimit) as MessageRow[]
    )
  }
  return exposeMessageListTimestamps(
    this.db
      .prepare(
        `SELECT * FROM messages WHERE run_id = ? AND to_handle = ?
         ORDER BY sequence DESC LIMIT ?`
      )
      .all(runId, address, rowLimit) as MessageRow[]
  )
}

export function getUnreadRunMailbox(
  this: OrchestrationDb,
  runId: string,
  limit = 100,
  types?: MessageType[]
): MessageRow[] {
  const address = `run:${runId}`
  const conditions = [
    'run_id = ?',
    'to_handle = ?',
    'read = 0',
    "delivery_contract = 'current_delivery'"
  ]
  const params: (string | number)[] = [runId, address]
  if (types?.length) {
    conditions.push(`type IN (${types.map(() => '?').join(',')})`)
    params.push(...types)
  }
  const indexClause = types?.length ? ' INDEXED BY idx_messages_unread_current_run_type' : ''
  params.push(Math.max(1, Math.floor(limit)))
  return exposeMessageListTimestamps(
    this.db
      .prepare(
        `SELECT * FROM messages${indexClause} WHERE ${conditions.join(' AND ')}
         ORDER BY sequence ASC LIMIT ?`
      )
      .all(...params) as MessageRow[]
  )
}

export type RunEventMessageRow = Pick<
  MessageRow,
  'id' | 'type' | 'from_handle' | 'subject' | 'sequence' | 'created_at'
>

/** Read-only page of Run mail after a sequence; the coordinator handle covers direct mail check later routes in. */
export function getRunEventMessages(
  this: OrchestrationDb,
  run: Pick<RunRow, 'id' | 'coordinator_handle'>,
  afterSequence: number
): RunEventMessageRow[] {
  const handles = [`run:${run.id}`, run.coordinator_handle].filter((handle) => handle !== null)
  const rows = this.db
    .prepare(
      `SELECT id, type, from_handle, subject, sequence, created_at FROM messages
       WHERE run_id = ? AND sequence > ? AND to_handle IN (${handles.map(() => '?').join(',')})
         AND delivery_contract = 'current_delivery' AND type != 'heartbeat'
       ORDER BY sequence LIMIT 100`
    )
    .all(run.id, afterSequence, ...handles)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SELECT names exactly the columns of this row type.
  return rows as RunEventMessageRow[]
}

export function getLatestMessageSequence(this: OrchestrationDb): number {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an aggregate SELECT always returns one row with this column.
  const row = this.db.prepare('SELECT MAX(sequence) AS sequence FROM messages').get() as {
    sequence: number | null
  }
  return row.sequence ?? 0
}

/** The live Dispatches of a Run that have a pane whose hook state can be read. */
export function getLiveRunDispatchPanes(
  this: OrchestrationDb,
  runId: string
): { id: string; task_id: string; assignee_pane_key: string }[] {
  const rows = this.db
    .prepare(
      `SELECT id, task_id, assignee_pane_key FROM dispatch_contexts
       WHERE run_id = ? AND status IN ('pending', 'dispatched') AND assignee_pane_key IS NOT NULL
       ORDER BY rowid`
    )
    .all(runId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SELECT names exactly the columns of this row type.
  return rows as { id: string; task_id: string; assignee_pane_key: string }[]
}

export function hasOutstandingRunDelivery(this: OrchestrationDb, runId: string): boolean {
  return this.hasOutstandingMailboxDelivery(`run:${runId}`)
}

export type RunDeliveryMethods = {
  requireCurrentConsumer: typeof requireCurrentConsumer
  getOrCreateRunDelivery: typeof getOrCreateRunDelivery
  takeRunDelivery: typeof takeRunDelivery
  acknowledgeRunDelivery: typeof acknowledgeRunDelivery
  getRunMailboxHistory: typeof getRunMailboxHistory
  getUnreadRunMailbox: typeof getUnreadRunMailbox
  hasOutstandingRunDelivery: typeof hasOutstandingRunDelivery
  getRunEventMessages: typeof getRunEventMessages
  getLatestMessageSequence: typeof getLatestMessageSequence
  getLiveRunDispatchPanes: typeof getLiveRunDispatchPanes
}

export function attachRunDelivery(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    requireCurrentConsumer,
    getOrCreateRunDelivery,
    takeRunDelivery,
    acknowledgeRunDelivery,
    getRunMailboxHistory,
    getUnreadRunMailbox,
    hasOutstandingRunDelivery,
    getRunEventMessages,
    getLatestMessageSequence,
    getLiveRunDispatchPanes
  })
}
