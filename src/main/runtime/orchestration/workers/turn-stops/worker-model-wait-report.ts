import type { OrchestrationDb } from '../../db/orchestration-db'
import { readWorkerPresence } from '../../db/worker-presence/worker-presence-store'
import { dispatchReportMailbox } from '../reports/dispatch-report-mailbox'
import { escalateWorkerFailure } from '../reports/worker-failure-escalation'
import {
  relayWorkerMail,
  stopReportId,
  workerTurnStopDispatchId,
  type WorkerTurnStopDispatch,
  type WorkerTurnStopReportDeps
} from './worker-turn-stop-report'
import { redactFailure } from './worker-turn-stop-wording'

/** A worker's turn is still open but its model is not answering. Neither notice stops or settles anything. */
export type WorkerModelWaitNotice = {
  from: string
  /** `retrying`: the provider's first retry this turn. `waiting`: no reply for `waitedMs` of model time. */
  kind: 'retrying' | 'waiting'
  /** The turn or stretch the notice is about: a second notice of the same one is a no-op. */
  stretchKey: string
  /** What the worker last showed: the retry's words, or its screen's status line. */
  lastSeen?: string
  waitedMs?: number
  /** Claude's transcript shows no model request since its last tool returned, at this time. */
  toolReturnedAt?: number
}

export const WORKER_MODEL_WAIT_MS = 10 * 60_000

const LAST_SEEN_MAX_CHARS = 300

/** Tells the coordinator once per stretch; false when nothing went out (already told, or no open work). */
export function reportWorkerModelWait(
  db: OrchestrationDb,
  target: WorkerTurnStopDispatch,
  notice: WorkerModelWaitNotice,
  deps: WorkerTurnStopReportDeps
): boolean {
  const dispatchId = workerTurnStopDispatchId(target)
  const presence = readWorkerPresence(db, dispatchId)?.presence
  // At rest or gone, the worker's own report says what happened; a stop the coordinator asked for is no news.
  if (
    (presence !== undefined && presence !== 'working') ||
    db.isWorkerStopRequested(dispatchId) ||
    (target.kind === 'local' && !isOpen(db, dispatchId))
  ) {
    return false
  }
  const id = stopReportId(dispatchId, `model-${notice.kind}:${notice.stretchKey}`)
  const subject =
    notice.kind === 'retrying' ? 'Worker is retrying the model API' : 'Worker has made no progress'
  const payload = {
    dispatchId,
    handle: notice.from,
    modelWait: notice.kind,
    ...(notice.lastSeen ? { lastSeen: modelWaitLastSeenLine(notice.lastSeen) } : {}),
    ...(notice.toolReturnedAt !== undefined
      ? { toolReturnedAt: new Date(notice.toolReturnedAt).toISOString() }
      : {})
  }
  const notify = deps.notify
  try {
    if (target.kind === 'remote') {
      const body = describeModelWait(notice, target.attachment.task_id)
      relayWorkerMail(db, target.attachment, {
        id,
        from: notice.from,
        subject,
        body,
        payload,
        ...(notice.kind === 'retrying' ? { notice: true as const } : {})
      })
      return true
    }
    const { dispatch } = target
    const sent = escalateWorkerFailure(
      db,
      dispatch,
      {
        id,
        from: notice.from,
        mailbox: () => dispatchReportMailbox(db, dispatch),
        describe: (task) => ({ subject, body: describeModelWait(notice, task) }),
        payload: { taskId: dispatch.task_id, ...payload },
        // A retry often clears on its own; a long wait may need the coordinator.
        ...(notice.kind === 'retrying' ? { notice: true as const } : {})
      },
      notify
    )
    // Already in mail from an earlier try is sent too.
    return sent !== null || db.getMessageById(id) !== undefined
  } catch (error) {
    console.warn(
      '[orchestration] failed to report a worker waiting on its model',
      dispatchId,
      error
    )
    return false
  }
}

function describeModelWait(notice: WorkerModelWaitNotice, task: string): string {
  const seen = notice.lastSeen
    ? ` Last seen: ${sentence(modelWaitLastSeenLine(notice.lastSeen))}`
    : ''
  if (notice.kind === 'retrying') {
    return `Worker ${notice.from} is retrying a model API error on task ${task}.${seen} It is still working; nothing was stopped.`
  }
  const minutes = Math.round((notice.waitedMs ?? WORKER_MODEL_WAIT_MS) / 60_000)
  if (notice.toolReturnedAt !== undefined) {
    const at = new Date(notice.toolReturnedAt).toISOString()
    return `Worker ${notice.from} has made no progress on task ${task} for ${minutes} min. It is stuck after a tool call: its transcript records no model request since the tool returned at ${at}.${seen} It is still running; nothing was stopped.`
  }
  // Inferred from silence, so it names no cause.
  return `Worker ${notice.from} has made no progress on task ${task} for ${minutes} min. It may be waiting on a slow reply, stuck on a tool, or the machine may be busy.${seen} It is still running; nothing was stopped.`
}

/** The screen line as mail carries it: one line, capped, with no capability or credential it showed. */
export function modelWaitLastSeenLine(text: string): string {
  const line = redactFailure(text).replace(/\s+/g, ' ').trim()
  return line.length > LAST_SEEN_MAX_CHARS
    ? `${line.slice(0, LAST_SEEN_MAX_CHARS - 1)}\u2026`
    : line
}

function isOpen(db: OrchestrationDb, dispatchId: string): boolean {
  const status = db.getDispatchContextById(dispatchId)?.status
  return status === 'pending' || status === 'dispatched'
}

function sentence(text: string): string {
  return /[.!?\u2026]$/u.test(text) ? text : `${text}.`
}
