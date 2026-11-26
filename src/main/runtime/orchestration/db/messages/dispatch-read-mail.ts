import { formatOrcaSessionAddress } from '../../../../../shared/agent-session/identity/orca-session-address'
import { dispatchReportMailbox } from '../../workers/reports/dispatch-report-mailbox'
import { isDispatchAssignee } from '../dispatch-context/dispatch-lookup'
import type { OrchestrationDb } from '../orchestration-db'
import type { DispatchContextRow } from '../orchestration-records'
import { currentRunCoordinatorOrcaSessionId } from '../runs/run-coordinator-orca-session'
import { exposeUtcTimestamp } from '../utc-timestamp'

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

export type ConsumedCoordinatorMessage = {
  id: string
  sequence: number
  threadId: string | null
  from: string
  createdAt: string
}

type CoordinatorMailSnapshot = {
  mailTaken: number
  latestCoordinatorSequence?: number
}

/** How much mail from above (its coordinator, or Orca for it) the worker has consumed, in any order.
 *  Mail a worker of the Run sent while its Dispatch was open (this worker's own heartbeats, its helpers'
 *  reports, a sibling's broadcast) does not count, nor does mail it has not taken yet. */
export function readCoordinatorMailCount(db: OrchestrationDb, dispatchId: string): number {
  return readCoordinatorMessages(db, dispatchId).length
}

/** Captures both the consumed count and highest consumed sequence at stop time. */
export function readCoordinatorMailSnapshot(
  db: OrchestrationDb,
  dispatchId: string
): CoordinatorMailSnapshot {
  const messages = readCoordinatorMessages(db, dispatchId)
  const latest = messages.at(-1)
  return {
    mailTaken: messages.length,
    ...(latest ? { latestCoordinatorSequence: latest.sequence } : {})
  }
}

/** Resolves the latest coordinator message the worker had consumed when its turn stopped. */
export function latestConsumedCoordinatorMessage(
  db: OrchestrationDb,
  dispatchId: string,
  stop: { mailTaken?: number; latestCoordinatorSequence?: number }
): ConsumedCoordinatorMessage | undefined {
  if (stop.mailTaken === 0) {
    return undefined
  }
  const allConsumed = readCoordinatorMessages(db, dispatchId)
  const maxSeq = stop.latestCoordinatorSequence
  return maxSeq !== undefined
    ? allConsumed.findLast((message) => message.sequence <= maxSeq)
    : allConsumed.at(-1)
}

function readCoordinatorMessages(
  db: OrchestrationDb,
  dispatchId: string
): ConsumedCoordinatorMessage[] {
  // The Dispatch that started this one is its coordinator, so its worker's mail is from above.
  const workers = nonCreatorRunWorkers(db, dispatchId)
  const read = db.db
    .prepare(
      `SELECT id, sequence, thread_id, from_handle, sender_pane_key, created_at
         FROM messages WHERE to_handle = ? AND read = 1 ORDER BY sequence ASC`
    )
    .all(`dispatch:${dispatchId}`)
  return read.flatMap((message) => {
    const id = text(message.id)
    const from = text(message.from_handle) ?? ''
    const createdAt = text(message.created_at) ?? ''
    const sentAt = parseDispatchUtcMs(createdAt)
    // The same agent can coordinate before or after it works; only what it sent while working is a worker's.
    if (
      !id ||
      typeof message.sequence !== 'number' ||
      workers.some(
        (worker) =>
          sentAt >= worker.createdAt &&
          (Number.isNaN(worker.completedAt) || sentAt <= worker.completedAt) &&
          (from === `dispatch:${worker.id}` ||
            isDispatchAssignee(worker, from, text(message.sender_pane_key)))
      )
    ) {
      return []
    }
    return [{ id, sequence: message.sequence, threadId: text(message.thread_id), from, createdAt }]
  })
}

export function coordinatorRecipients(
  db: OrchestrationDb,
  dispatch: DispatchContextRow,
  latestFrom: string | undefined
): Set<string> {
  const recipients = new Set<string>([
    `run:${dispatch.run_id}`,
    dispatchReportMailbox(db, dispatch)
  ])
  const add = (address: string | null | undefined): void => {
    if (address) {
      recipients.add(address)
    }
  }
  add(latestFrom)
  if (dispatch.creator_dispatch_id) {
    add(`dispatch:${dispatch.creator_dispatch_id}`)
    const creator = db.getDispatchContextById(dispatch.creator_dispatch_id)
    add(creator?.assignee_handle)
    add(
      creator?.assignee_orca_session_id &&
        formatOrcaSessionAddress(creator.assignee_orca_session_id)
    )
  }
  add(dispatch.creator_handle)
  add(
    dispatch.creator_orca_session_id && formatOrcaSessionAddress(dispatch.creator_orca_session_id)
  )
  const run = db.getRun(dispatch.run_id)
  add(run?.coordinator_handle)
  const coordinatorSession = run ? currentRunCoordinatorOrcaSessionId(run) : null
  add(coordinatorSession && formatOrcaSessionAddress(coordinatorSession))
  const workers = nonCreatorRunWorkers(db, dispatch.id)
  for (const row of db.db
    .prepare('SELECT terminal_handle FROM run_coordinator_handles WHERE run_id = ?')
    .all(dispatch.run_id)) {
    const handle = text(row.terminal_handle)
    if (
      handle &&
      !workers.some(
        (worker) => Number.isNaN(worker.completedAt) && worker.assignee_handle === handle
      )
    ) {
      recipients.add(handle)
    }
  }
  return recipients
}

function nonCreatorRunWorkers(db: OrchestrationDb, dispatchId: string) {
  return db.db
    .prepare(
      `SELECT d.id, d.assignee_handle, d.assignee_pane_key, d.created_at, d.completed_at
         FROM dispatch_contexts d JOIN dispatch_contexts own ON own.id = ?
        WHERE d.run_id = own.run_id AND d.id IS NOT own.creator_dispatch_id`
    )
    .all(dispatchId)
    .flatMap((row) => {
      const id = text(row.id)
      const handle = text(row.assignee_handle)
      return id && handle
        ? [
            {
              id,
              assignee_handle: handle,
              assignee_pane_key: text(row.assignee_pane_key),
              createdAt: parseDispatchUtcMs(text(row.created_at)),
              completedAt: Date.parse(text(row.completed_at) ?? '')
            }
          ]
        : []
    })
}

export function parseDispatchUtcMs(raw: string | null): number {
  return Date.parse(exposeUtcTimestamp(raw) ?? '')
}
