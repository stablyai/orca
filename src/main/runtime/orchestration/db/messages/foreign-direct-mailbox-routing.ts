import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import type { DispatchContextRow, MessageType } from '../../types'
import { DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL, paneKeyMatchSuffix } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'
import { DISPATCH_CONTEXT_COLUMN_LIST } from '../row-column-lists'
import {
  ORCHESTRATION_DELIVERY_BATCH_LIMIT,
  type ForeignDirectMailboxRoutingPage
} from './mailbox-routing-page'

export function findActiveDispatchForDirectMessageOwner(
  this: OrchestrationDb,
  runId: string,
  directHandle: string,
  paneKey?: string
): DispatchContextRow | undefined {
  const rawExact = this.db
    .prepare(
      `SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts
       WHERE run_id = ? AND assignee_handle = ? AND status IN ('pending', 'dispatched')
       ORDER BY rowid DESC LIMIT 1`
    )
    .get(runId, directHandle)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The schema-pinned complete Dispatch projection returns one Dispatch row or undefined; the adapter exposes unknown.
  const exact = rawExact as DispatchContextRow | undefined
  if (exact || !paneKey || !parsePaneKey(paneKey)) {
    return exact
  }
  const reminted = this.db
    .prepare(
      `SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts
       WHERE run_id = ? AND assignee_pane_key IS NOT NULL
         AND status IN ('pending', 'dispatched') AND instr(assignee_pane_key, ':') > 1
         AND ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ?
       ORDER BY rowid DESC LIMIT 1`
    )
    .get(runId, paneKeyMatchSuffix(paneKey))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The schema-pinned complete Dispatch projection returns one Dispatch row or undefined; the adapter exposes unknown.
  return reminted as DispatchContextRow | undefined
}

export function routeForeignDirectMessagesToOwnedMailboxes(
  this: OrchestrationDb,
  directHandle: string,
  currentRunId?: string,
  paneKey?: string
): ForeignDirectMailboxRoutingPage {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const runExclusion = currentRunId === undefined ? '' : ' AND candidate.run_id <> ?'
    const paneSuffix = paneKey && parsePaneKey(paneKey) ? paneKeyMatchSuffix(paneKey) : undefined
    const exclusionParams = currentRunId === undefined ? [] : [currentRunId]
    const branches = [
      `SELECT candidate.id, candidate.run_id, candidate.type, candidate.sequence
       FROM run_coordinator_handles AS coordinator
       JOIN runs AS owner_run ON owner_run.id = coordinator.run_id AND owner_run.legacy = 0
       JOIN messages AS candidate INDEXED BY idx_messages_undelivered_direct_run
         ON candidate.run_id = coordinator.run_id
        AND candidate.to_handle = coordinator.terminal_handle
       WHERE coordinator.terminal_handle = ?${runExclusion}
         AND candidate.read = 0 AND candidate.delivered_at IS NULL
         AND candidate.delivery_contract = 'current_delivery'`,
      `SELECT candidate.id, candidate.run_id, candidate.type, candidate.sequence
       FROM (
         SELECT direct_dispatch.run_id
         FROM dispatch_contexts AS direct_dispatch
           INDEXED BY idx_dispatch_active_assignee_handle
         JOIN runs AS owner_run
           ON owner_run.id = direct_dispatch.run_id AND owner_run.legacy = 0
         WHERE direct_dispatch.assignee_handle = ?
           AND direct_dispatch.status IN ('pending', 'dispatched')
         GROUP BY direct_dispatch.run_id
       ) AS dispatch_owner
       JOIN messages AS candidate INDEXED BY idx_messages_undelivered_direct_run
         ON candidate.run_id = dispatch_owner.run_id AND candidate.to_handle = ?
       WHERE 1 = 1${runExclusion}
         AND candidate.read = 0 AND candidate.delivered_at IS NULL
         AND candidate.delivery_contract = 'current_delivery'`
    ]
    const branchParams: (string | number)[][] = [
      [directHandle, ...exclusionParams, ORCHESTRATION_DELIVERY_BATCH_LIMIT + 1],
      [directHandle, directHandle, ...exclusionParams, ORCHESTRATION_DELIVERY_BATCH_LIMIT + 1]
    ]
    if (paneSuffix !== undefined) {
      branches.push(
        `SELECT candidate.id, candidate.run_id, candidate.type, candidate.sequence
         FROM (
           SELECT pane_dispatch.run_id
           FROM dispatch_contexts AS pane_dispatch INDEXED BY idx_dispatch_assignee_pane_leaf
           JOIN runs AS owner_run
             ON owner_run.id = pane_dispatch.run_id AND owner_run.legacy = 0
           WHERE pane_dispatch.assignee_pane_key IS NOT NULL
             AND pane_dispatch.status IN ('pending', 'dispatched')
             AND instr(pane_dispatch.assignee_pane_key, ':') > 1
             AND ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ?
           GROUP BY pane_dispatch.run_id
         ) AS pane_owner
         JOIN messages AS candidate INDEXED BY idx_messages_undelivered_direct_run
           ON candidate.run_id = pane_owner.run_id AND candidate.to_handle = ?
         WHERE 1 = 1${runExclusion}
           AND candidate.read = 0 AND candidate.delivered_at IS NULL
           AND candidate.delivery_contract = 'current_delivery'`
      )
      branchParams.push([
        paneSuffix,
        directHandle,
        ...exclusionParams,
        ORCHESTRATION_DELIVERY_BATCH_LIMIT + 1
      ])
    }
    const limitedBranches = branches.map(
      (branch) => `SELECT * FROM (${branch} ORDER BY candidate.sequence LIMIT ?)`
    )
    const rows = this.db
      .prepare(
        `SELECT id, run_id, type FROM (${limitedBranches.join(' UNION ')})
         ORDER BY sequence LIMIT ?`
      )
      .all(...branchParams.flat(), ORCHESTRATION_DELIVERY_BATCH_LIMIT + 1) as {
      id: string
      run_id: string
      type: MessageType
    }[]
    const page = rows.slice(0, ORCHESTRATION_DELIVERY_BATCH_LIMIT)
    if (page.length === 0) {
      this.db.exec('COMMIT')
      return { routedCount: 0, hasMore: false, types: [], mailboxes: [] }
    }
    const runIds = [...new Set(page.map((row) => row.run_id))]
    const dispatchByRun = new Map<string, DispatchContextRow>()
    for (const runId of runIds) {
      const dispatch = this.findActiveDispatchForDirectMessageOwner(runId, directHandle, paneKey)
      if (dispatch) {
        dispatchByRun.set(runId, dispatch)
      }
    }
    const idsByMailbox = new Map<string, string[]>()
    const byMailbox = new Map<string, Set<MessageType>>()
    for (const row of page) {
      const dispatch = dispatchByRun.get(row.run_id)
      const mailboxHandle = dispatch ? `dispatch:${dispatch.id}` : `run:${row.run_id}`
      const ids = idsByMailbox.get(mailboxHandle) ?? []
      ids.push(row.id)
      idsByMailbox.set(mailboxHandle, ids)
      const types = byMailbox.get(mailboxHandle) ?? new Set<MessageType>()
      types.add(row.type)
      byMailbox.set(mailboxHandle, types)
    }
    for (const [mailboxHandle, ids] of idsByMailbox) {
      const placeholders = ids.map(() => '?').join(',')
      this.db
        .prepare(
          `UPDATE messages INDEXED BY idx_messages_id SET to_handle = ?
           WHERE to_handle = ? AND read = 0 AND delivered_at IS NULL
             AND delivery_contract = 'current_delivery' AND id IN (${placeholders})`
        )
        .run(mailboxHandle, directHandle, ...ids)
    }
    this.db.exec('COMMIT')
    return {
      routedCount: page.length,
      hasMore: rows.length > ORCHESTRATION_DELIVERY_BATCH_LIMIT,
      types: [...new Set(page.map((row) => row.type))],
      mailboxes: [...byMailbox].map(([mailboxHandle, types]) => ({
        mailboxHandle,
        types: [...types]
      }))
    }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Which of these direct rows a Run still owns, by the same coordinator/Dispatch rules routing uses.
 * Read-only: a pointer must leave such rows undelivered, since routing only moves undelivered rows.
 */
export function listRunOwnedDirectMessageIds(
  this: OrchestrationDb,
  directHandle: string,
  messageIds: readonly string[],
  paneKey?: string
): Set<string> {
  if (messageIds.length === 0) {
    return new Set()
  }
  const paneSuffix = paneKey && parsePaneKey(paneKey) ? paneKeyMatchSuffix(paneKey) : undefined
  const paneOwner =
    paneSuffix === undefined
      ? ''
      : `OR EXISTS (
           SELECT 1 FROM (
             SELECT pane_dispatch.run_id FROM dispatch_contexts AS pane_dispatch
             WHERE pane_dispatch.assignee_pane_key IS NOT NULL
               AND instr(pane_dispatch.assignee_pane_key, ':') > 1
               AND pane_dispatch.status IN ('pending', 'dispatched')
               AND ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ?
           ) AS pane_owner JOIN runs AS owner_run
             ON owner_run.id = pane_owner.run_id AND owner_run.legacy = 0
           WHERE pane_owner.run_id = candidate.run_id)`
  const placeholders = messageIds.map(() => '?').join(',')
  const rows = this.db
    .prepare(
      `SELECT candidate.id FROM messages AS candidate
       WHERE candidate.to_handle = ? AND candidate.id IN (${placeholders})
         AND (
           EXISTS (
             SELECT 1 FROM run_coordinator_handles AS coordinator JOIN runs AS owner_run
               ON owner_run.id = coordinator.run_id AND owner_run.legacy = 0
             WHERE coordinator.run_id = candidate.run_id
               AND coordinator.terminal_handle = candidate.to_handle)
           OR EXISTS (
             SELECT 1 FROM dispatch_contexts AS direct_dispatch JOIN runs AS owner_run
               ON owner_run.id = direct_dispatch.run_id AND owner_run.legacy = 0
             WHERE direct_dispatch.run_id = candidate.run_id
               AND direct_dispatch.assignee_handle = candidate.to_handle
               AND direct_dispatch.status IN ('pending', 'dispatched'))
           ${paneOwner}
         )`
    )
    .all(directHandle, ...messageIds, ...(paneSuffix === undefined ? [] : [paneSuffix])) as {
    id: string
  }[]
  return new Set(rows.map((row) => row.id))
}

export function getUnreadDirectMessageTypes(
  this: OrchestrationDb,
  directHandle: string
): MessageType[] {
  return (
    this.db
      .prepare(
        `SELECT DISTINCT type FROM messages INDEXED BY idx_messages_unread_current_inbox_type
         WHERE to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery'
         ORDER BY type`
      )
      .all(directHandle) as { type: MessageType }[]
  ).map((row) => row.type)
}

export type ForeignDirectMailboxRoutingMethods = {
  findActiveDispatchForDirectMessageOwner: typeof findActiveDispatchForDirectMessageOwner
  routeForeignDirectMessagesToOwnedMailboxes: typeof routeForeignDirectMessagesToOwnedMailboxes
  listRunOwnedDirectMessageIds: typeof listRunOwnedDirectMessageIds
  getUnreadDirectMessageTypes: typeof getUnreadDirectMessageTypes
}

export function attachForeignDirectMailboxRouting(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    findActiveDispatchForDirectMessageOwner,
    routeForeignDirectMessagesToOwnedMailboxes,
    listRunOwnedDirectMessageIds,
    getUnreadDirectMessageTypes
  })
}
