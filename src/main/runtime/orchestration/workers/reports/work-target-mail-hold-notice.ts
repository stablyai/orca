import { createHash } from 'node:crypto'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { MessageRow } from '../../db/orchestration-records'
import { dispatchReportMailbox } from './dispatch-report-mailbox'
import { escalateWorkerFailure } from './worker-failure-escalation'

const activeFollowThroughByDb = new WeakMap<OrchestrationDb, Set<string>>()

export function beginUnreadFollowThrough(db: OrchestrationDb, dispatchId: string): void {
  let active = activeFollowThroughByDb.get(db)
  if (!active) {
    active = new Set()
    activeFollowThroughByDb.set(db, active)
  }
  active.add(dispatchId)
}

export function endUnreadFollowThrough(db: OrchestrationDb, dispatchId: string): void {
  activeFollowThroughByDb.get(db)?.delete(dispatchId)
}

export function isUnreadFollowThroughActive(db: OrchestrationDb, dispatchId: string): boolean {
  return activeFollowThroughByDb.get(db)?.has(dispatchId) ?? false
}

/** Deterministic ID per held targeted message batch so retries and overlapping boundaries never duplicate notices. */
export function workTargetHoldNoticeId(
  dispatchId: string,
  heldMessageIds: readonly string[]
): string {
  const sorted = [...new Set(heldMessageIds)].sort()
  return `msg_target_hold_${createHash('sha256')
    .update(JSON.stringify([dispatchId, sorted]))
    .digest('hex')
    .slice(0, 24)}`
}

/** Preserve durable recovery marker on a Dispatch holding unread mail without churning an existing timestamp. */
export function preserveUnreadFollowUpMail(db: OrchestrationDb, dispatchId: string): void {
  db.db
    .prepare(
      `UPDATE dispatch_contexts
          SET follow_up_mail_at = COALESCE(follow_up_mail_at, datetime('now'))
        WHERE id = ? AND EXISTS (
          SELECT 1 FROM messages
           WHERE to_handle = 'dispatch:' || dispatch_contexts.id
             AND read = 0 AND delivery_contract = 'current_delivery'
        )`
    )
    .run(dispatchId)
}

/** Notify the live helper creator or Run coordinator once when targeted unread work mail is held instead of rerouted. */
export function notifyTargetedMailHeld(
  notify: (handle: string, messageType: string) => void,
  db: OrchestrationDb,
  args: {
    dispatchId: string
    heldMessageIds: readonly string[]
    reason: string
    runIdFallback?: string
  }
): MessageRow | null {
  const sortedIds = [...new Set(args.heldMessageIds)].sort()
  if (sortedIds.length === 0) {
    return null
  }
  const id = workTargetHoldNoticeId(args.dispatchId, sortedIds)
  if (db.getMessageById?.(id)) {
    return null
  }
  const dispatch = db.getDispatchContextById(args.dispatchId)
  if (dispatch) {
    return escalateWorkerFailure(
      db,
      dispatch,
      {
        id,
        from: `dispatch:${args.dispatchId}`,
        mailbox: () => dispatchReportMailbox(db, dispatch),
        describe: (task) => ({
          subject: 'Mail did not reach the finished worker',
          body: `Orca held ${sortedIds.length} targeted unread message(s) for ${task} instead of delivering them to an unverified destination: ${args.reason}. The original mail remains unread on dispatch:${args.dispatchId} for recovery.`
        }),
        payload: {
          kind: 'work_target_mail_held',
          dispatchId: args.dispatchId,
          heldMessageIds: sortedIds,
          reason: args.reason
        }
      },
      notify
    )
  }
  if (!args.runIdFallback) {
    return null
  }
  const owningRun = db.getRun?.(args.runIdFallback)
  if (!owningRun || owningRun.legacy === 1) {
    return null
  }
  try {
    const message = db.insertMessage({
      id,
      from: `dispatch:${args.dispatchId}`,
      to: `run:${owningRun.id}`,
      subject: 'Mail did not reach the finished worker',
      body: `Orca held ${sortedIds.length} targeted unread message(s) for dispatch:${args.dispatchId} instead of moving them to run:${owningRun.id}: ${args.reason}. The original mail remains unread on dispatch:${args.dispatchId} for recovery.`,
      type: 'escalation',
      priority: 'high',
      payload: JSON.stringify({
        kind: 'work_target_mail_held',
        dispatchId: args.dispatchId,
        heldMessageIds: sortedIds,
        reason: args.reason
      }),
      runId: owningRun.id
    })
    notify(message.to_handle, message.type)
    return message
  } catch (error) {
    console.warn('[orchestration] failed to notify held targeted mail', {
      dispatchId: args.dispatchId,
      runId: owningRun.id,
      error
    })
    return null
  }
}
