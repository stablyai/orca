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

/** Notify the live helper creator or Run coordinator once when targeted unread work mail is held instead of rerouted or exposed. */
export function notifyTargetedMailHeld(
  notify: (handle: string, messageType: string) => void,
  db: OrchestrationDb,
  args: {
    dispatchId?: string
    mailboxHandle?: string
    heldMessageIds: readonly string[]
    reason: string
    runIdFallback?: string
  }
): MessageRow | null {
  const sortedIds = [...new Set(args.heldMessageIds)].sort()
  if (sortedIds.length === 0) {
    return null
  }
  const sourceKey = args.dispatchId ?? args.mailboxHandle
  if (!sourceKey) {
    return null
  }
  const id = workTargetHoldNoticeId(sourceKey, sortedIds)
  if (db.getMessageById?.(id)) {
    return null
  }
  const dispatch = args.dispatchId ? db.getDispatchContextById(args.dispatchId) : undefined
  if (dispatch && args.dispatchId) {
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
  const sourceMailbox = args.mailboxHandle ?? (args.dispatchId ? `dispatch:${args.dispatchId}` : '')
  try {
    const message = db.insertMessage({
      id,
      from: sourceMailbox,
      to: `run:${owningRun.id}`,
      subject: args.dispatchId
        ? 'Mail did not reach the finished worker'
        : 'Targeted mail held pending verification',
      body: `Orca held ${sortedIds.length} targeted unread message(s) for ${sourceMailbox} instead of delivering them to an unverified destination: ${args.reason}. The original mail remains unread on ${sourceMailbox} for recovery.`,
      type: 'escalation',
      priority: 'high',
      payload: JSON.stringify({
        kind: 'work_target_mail_held',
        ...(args.dispatchId ? { dispatchId: args.dispatchId } : { mailboxHandle: sourceMailbox }),
        heldMessageIds: sortedIds,
        reason: args.reason
      }),
      runId: owningRun.id
    })
    notify(message.to_handle, message.type)
    return message
  } catch (error) {
    console.warn('[orchestration] failed to notify held targeted mail', {
      sourceMailbox,
      runId: owningRun.id,
      error
    })
    return null
  }
}
