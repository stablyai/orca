import type { MessageType, MessageRow, RunRow, DeliveryRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { exposeMessageListTimestamps } from '../utc-timestamp'
import type { OrchestrationDb } from '../orchestration-db'

export function requireCurrentConsumer(
  this: OrchestrationDb,
  runId: string,
  consumerGeneration: number
): RunRow {
  const run = this.getRunRaw(runId)
  if (!run || run.legacy === 1 || run.consumer_generation !== consumerGeneration) {
    throw new OrchestrationError(
      'consumer_fenced',
      'This mailbox consumer has been replaced. Rebind with orchestration run-use.'
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
    wakeTypes: params.wakeTypes,
    requireCurrentRunConsumer: true
  })
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
    deliveryId: params.deliveryId,
    requireCurrentRunConsumer: true
  })
}

export function getRunMailboxHistory(
  this: OrchestrationDb,
  runId: string,
  limit = 100,
  types?: MessageType[]
): MessageRow[] {
  const address = `run:${runId}`
  // Why: SQLite reads a negative LIMIT as unbounded, so an unsanitized caller value dumps the whole mailbox.
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

export function hasOutstandingRunDelivery(this: OrchestrationDb, runId: string): boolean {
  return this.hasOutstandingMailboxDelivery(`run:${runId}`)
}

export type RunDeliveryMethods = {
  requireCurrentConsumer: typeof requireCurrentConsumer
  getOrCreateRunDelivery: typeof getOrCreateRunDelivery
  acknowledgeRunDelivery: typeof acknowledgeRunDelivery
  getRunMailboxHistory: typeof getRunMailboxHistory
  getUnreadRunMailbox: typeof getUnreadRunMailbox
  hasOutstandingRunDelivery: typeof hasOutstandingRunDelivery
}

export function attachRunDelivery(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    requireCurrentConsumer,
    getOrCreateRunDelivery,
    acknowledgeRunDelivery,
    getRunMailboxHistory,
    getUnreadRunMailbox,
    hasOutstandingRunDelivery
  })
}
