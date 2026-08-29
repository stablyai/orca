import type { MessageType } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT, type MailboxRoutingPage } from './mailbox-routing-page'

export function hasUndeliveredDirectMessageForRun(
  this: OrchestrationDb,
  runId: string,
  directHandle: string
): boolean {
  return Boolean(
    this.db
      .prepare(
        `SELECT 1 FROM messages INDEXED BY idx_messages_undelivered_direct_run
         WHERE run_id = ? AND to_handle = ? AND read = 0 AND delivered_at IS NULL
           AND delivery_contract = 'current_delivery'
         LIMIT 1`
      )
      .get(runId, directHandle)
  )
}

export function getLatestUnreadDirectMessageSequenceForRun(
  this: OrchestrationDb,
  runId: string,
  directHandle: string
): number | undefined {
  const row = this.db
    .prepare(
      `SELECT sequence FROM messages
       WHERE run_id = ? AND to_handle = ? AND read = 0
         AND delivery_contract = 'current_delivery'
       ORDER BY sequence DESC LIMIT 1`
    )
    .get(runId, directHandle) as { sequence: number } | undefined
  return row?.sequence
}

// Why: change mailbox ownership without changing unread or acknowledgment state.
export function routeDirectMessagePage(
  this: OrchestrationDb,
  mailboxHandle: string,
  runId: string,
  directHandle: string,
  throughSequence?: number,
  preserveActiveDispatchOwnership = false
): MailboxRoutingPage {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const throughClause = throughSequence === undefined ? '' : ' AND sequence <= ?'
    const dispatchOwnershipClause = preserveActiveDispatchOwnership
      ? ` AND NOT EXISTS (
           SELECT 1 FROM dispatch_contexts
           WHERE dispatch_contexts.run_id = messages.run_id
             AND dispatch_contexts.assignee_handle = messages.to_handle
             AND dispatch_contexts.status IN ('pending', 'dispatched')
         )`
      : ''
    const params: (string | number)[] = [runId, directHandle]
    if (throughSequence !== undefined) {
      params.push(throughSequence)
    }
    params.push(ORCHESTRATION_DELIVERY_BATCH_LIMIT + 1)
    const rows = this.db
      .prepare(
        `SELECT id, type FROM messages
         WHERE run_id = ? AND to_handle = ? AND read = 0
           AND delivery_contract = 'current_delivery'${throughClause}${dispatchOwnershipClause}
         ORDER BY sequence LIMIT ?`
      )
      .all(...params) as { id: string; type: MessageType }[]
    const page = rows.slice(0, ORCHESTRATION_DELIVERY_BATCH_LIMIT)
    if (page.length === 0) {
      this.db.exec('COMMIT')
      return { routedCount: 0, hasMore: false, types: [] }
    }
    const placeholders = page.map(() => '?').join(',')
    const result = this.db
      .prepare(
        `UPDATE messages INDEXED BY idx_messages_id SET to_handle = ?
         WHERE run_id = ? AND to_handle = ? AND read = 0
           AND delivery_contract = 'current_delivery' AND id IN (${placeholders})`
      )
      .run(mailboxHandle, runId, directHandle, ...page.map((row) => row.id))
    this.db.exec('COMMIT')
    return {
      routedCount: Number(result.changes),
      hasMore: rows.length > ORCHESTRATION_DELIVERY_BATCH_LIMIT,
      types: [...new Set(page.map((row) => row.type))]
    }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function routeUnreadDirectMessagesToRunMailbox(
  this: OrchestrationDb,
  runId: string,
  directHandle: string,
  throughSequence?: number
): MailboxRoutingPage {
  return this.routeDirectMessagePage(`run:${runId}`, runId, directHandle, throughSequence, true)
}

export function routeUnreadDirectMessagesToDispatchMailbox(
  this: OrchestrationDb,
  dispatchId: string,
  runId: string,
  directHandle: string,
  throughSequence?: number
): MailboxRoutingPage {
  return this.routeDirectMessagePage(`dispatch:${dispatchId}`, runId, directHandle, throughSequence)
}

export function routeUnreadDispatchMailboxToRunMailbox(
  this: OrchestrationDb,
  dispatchId: string,
  runId: string,
  throughSequence?: number
): MailboxRoutingPage {
  const dispatchMailbox = `dispatch:${dispatchId}`
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const throughClause = throughSequence === undefined ? '' : ' AND sequence <= ?'
    const params: (string | number)[] = [runId, dispatchMailbox]
    if (throughSequence !== undefined) {
      params.push(throughSequence)
    }
    params.push(ORCHESTRATION_DELIVERY_BATCH_LIMIT + 1)
    const rows = this.db
      .prepare(
        `SELECT id, type FROM messages INDEXED BY idx_messages_unread_current_inbox
         WHERE run_id = ? AND to_handle = ? AND read = 0
           AND delivery_contract = 'current_delivery'${throughClause}
         ORDER BY sequence LIMIT ?`
      )
      .all(...params) as { id: string; type: MessageType }[]
    const page = rows.slice(0, ORCHESTRATION_DELIVERY_BATCH_LIMIT)
    if (page.length === 0) {
      this.db.exec('COMMIT')
      return { routedCount: 0, hasMore: false, types: [] }
    }
    const placeholders = page.map(() => '?').join(',')
    const result = this.db
      .prepare(
        `UPDATE messages INDEXED BY idx_messages_id SET to_handle = ?
         WHERE run_id = ? AND to_handle = ? AND read = 0
           AND delivery_contract = 'current_delivery'
           AND id IN (${placeholders})`
      )
      .run(`run:${runId}`, runId, dispatchMailbox, ...page.map((row) => row.id))
    this.db.exec('COMMIT')
    return {
      routedCount: Number(result.changes),
      hasMore: rows.length > ORCHESTRATION_DELIVERY_BATCH_LIMIT,
      types: [...new Set(page.map((row) => row.type))]
    }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function getLatestUnreadMessageSequence(
  this: OrchestrationDb,
  mailboxHandle: string
): number | undefined {
  const row = this.db
    .prepare(
      `SELECT sequence FROM messages INDEXED BY idx_messages_unread_current_inbox
       WHERE to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery'
       ORDER BY sequence DESC LIMIT 1`
    )
    .get(mailboxHandle) as { sequence: number } | undefined
  return row?.sequence
}

export type DirectMailboxRoutingMethods = {
  hasUndeliveredDirectMessageForRun: typeof hasUndeliveredDirectMessageForRun
  getLatestUnreadDirectMessageSequenceForRun: typeof getLatestUnreadDirectMessageSequenceForRun
  routeDirectMessagePage: typeof routeDirectMessagePage
  routeUnreadDirectMessagesToRunMailbox: typeof routeUnreadDirectMessagesToRunMailbox
  routeUnreadDirectMessagesToDispatchMailbox: typeof routeUnreadDirectMessagesToDispatchMailbox
  routeUnreadDispatchMailboxToRunMailbox: typeof routeUnreadDispatchMailboxToRunMailbox
  getLatestUnreadMessageSequence: typeof getLatestUnreadMessageSequence
}

export function attachDirectMailboxRouting(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    hasUndeliveredDirectMessageForRun,
    getLatestUnreadDirectMessageSequenceForRun,
    routeDirectMessagePage,
    routeUnreadDirectMessagesToRunMailbox,
    routeUnreadDirectMessagesToDispatchMailbox,
    routeUnreadDispatchMailboxToRunMailbox,
    getLatestUnreadMessageSequence
  })
}
