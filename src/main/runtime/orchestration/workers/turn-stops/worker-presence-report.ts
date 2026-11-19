import { createHash } from 'node:crypto'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { readCoordinatorMailCount } from '../../db/messages/dispatch-read-mail'
import {
  hasRelayedWorkerReport,
  nextWorkerPresence,
  readWorkerPresence,
  writeWorkerPresence,
  type WorkerPresenceRow
} from '../../db/worker-presence/worker-presence-store'
import {
  isDeliberateRest,
  sendWorkerReport,
  stopReportId,
  workerTurnStopDispatchId,
  type WorkerTurnStop,
  type WorkerTurnStopDispatch,
  type WorkerTurnStopReportDeps
} from './worker-turn-stop-report'

// Kept with an undecided rest; the report shows only the end of it.
const STORED_OUTPUT_MAX_CHARS = 2_000

export type WorkerRest = Pick<
  WorkerTurnStop,
  'from' | 'lastOutput' | 'awaitsReply' | 'approval' | 'turnStartedAt' | 'mailTaken'
> & { reason: 'finished' | 'errored' | 'needs-input' }

/** What an edge saw of its worker. `fence` names the rest: its process or chat turn and when it began,
 *  so the same rest seen twice is one fact and a new rest is another, even in the same presence. */
export type WorkerObservation =
  | { presence: 'working' }
  | {
      presence: 'at-rest'
      fence: string
      rest: WorkerRest
      /** The key builds before the presence table gave this rest; its report must not go out twice. */
      legacyStopKey: string
    }

type StoredRest = WorkerRest & { legacyStopKey: string }

/** Edges only observe; whether and how the coordinator hears of it is decided below.
 *  Callers have checked the observation is current. True when a report of this rest is in mail. */
export function observeWorker(
  db: OrchestrationDb,
  target: WorkerTurnStopDispatch,
  observation: WorkerObservation,
  deps: WorkerTurnStopReportDeps
): boolean {
  const dispatchId = workerTurnStopDispatchId(target)
  const current = readWorkerPresence(db, dispatchId)
  if (observation.presence === 'working') {
    const next = nextWorkerPresence(current, { presence: 'working', fence: null, report: null })
    if (next.changed) {
      writeWorkerPresence(db, dispatchId, next)
    }
    return false
  }
  const { rest } = observation
  const stored: StoredRest = {
    ...rest,
    ...(rest.lastOutput && rest.lastOutput.length > STORED_OUTPUT_MAX_CHARS
      ? { lastOutput: rest.lastOutput.slice(-STORED_OUTPUT_MAX_CHARS) }
      : {}),
    legacyStopKey: observation.legacyStopKey
  }
  // Seen again, an undecided rest is decided again: what held it back may have cleared.
  const sent = reconcileWorkerReport(
    db,
    target,
    nextWorkerPresence(current, {
      presence: rest.reason === 'needs-input' ? 'prompt' : 'resting',
      fence: observation.fence,
      report: JSON.stringify(stored)
    }),
    deps
  )
  // One report per approval: an approval already reported under another rest is in mail too.
  return (
    sent ||
    (rest.approval !== undefined &&
      target.kind === 'local' &&
      db.getMessageById(approvalReportId(dispatchId, rest.approval.approvalId)) !== undefined)
  )
}

/** Decides, words and sends the report of the worker's current rest, once. Writes the row once: with the
 *  report's mail when it goes out, else as decided or still undecided. True when it went out now. */
function reconcileWorkerReport(
  db: OrchestrationDb,
  target: WorkerTurnStopDispatch,
  row: WorkerPresenceRow & { changed: boolean },
  deps: WorkerTurnStopReportDeps
): boolean {
  const dispatchId = workerTurnStopDispatchId(target)
  const keep = () => {
    if (row.changed) {
      writeWorkerPresence(db, dispatchId, row)
    }
    return false
  }
  const decided = (mailCount: number | undefined): WorkerPresenceRow => ({
    ...row,
    report: null,
    reportedGeneration: row.generation,
    reportedMailCount: mailCount ?? row.reportedMailCount
  })
  if (
    !row.report ||
    (row.presence !== 'resting' && row.presence !== 'prompt') ||
    (row.reportedGeneration ?? 0) >= row.generation
  ) {
    return keep()
  }
  const rest = parseRest(row.report)
  if (!rest) {
    writeWorkerPresence(db, dispatchId, decided(undefined))
    return false
  }
  // Left undecided: the same rest seen again is decided again.
  if (isDeliberateRest(db, target, rest, deps)) {
    return keep()
  }
  // An idle finish answers the coordinator's mail the worker took, so it is news once per mail taken: a later
  // idle turn (a worker on its own schedule, or one the user is talking to) repeats what the coordinator was told.
  const finishedMail =
    rest.reason === 'finished'
      ? (rest.mailTaken ?? readCoordinatorMailCount(db, dispatchId))
      : undefined
  if (
    (finishedMail !== undefined &&
      row.reportedMailCount !== null &&
      finishedMail <= row.reportedMailCount) ||
    reportedByEarlierBuild(db, target, rest, row, finishedMail)
  ) {
    writeWorkerPresence(db, dispatchId, decided(finishedMail))
    return false
  }
  const id = rest.approval
    ? approvalReportId(dispatchId, rest.approval.approvalId)
    : presenceReportId(dispatchId, row.generation)
  const sent = sendWorkerReport(db, target, rest, id, deps, () =>
    writeWorkerPresence(db, dispatchId, decided(finishedMail))
  )
  return sent || keep()
}

/** One stable id per rest: writing it twice, here or at a Run home, is a no-op. */
export function presenceReportId(dispatchId: string, generation: number): string {
  return `msg_rest_${createHash('sha256')
    .update(JSON.stringify([dispatchId, generation]))
    .digest('hex')
    .slice(0, 24)}`
}

/** Approvals open and close on their own, so each keeps one report whatever the worker does meanwhile. */
function approvalReportId(dispatchId: string, approvalId: string): string {
  return stopReportId(dispatchId, `approval:${approvalId}`)
}

/** A build before the presence table may already have told the coordinator of this rest, by its own key.
 *  Looked up only until this Dispatch's first report here: after that the row knows. */
function reportedByEarlierBuild(
  db: OrchestrationDb,
  target: WorkerTurnStopDispatch,
  rest: StoredRest,
  row: { reportedGeneration: number | null; reportedMailCount: number | null },
  finishedMail: number | undefined
): boolean {
  const legacyKey =
    finishedMail !== undefined
      ? row.reportedMailCount === null && `finished:${finishedMail}`
      : !rest.approval && row.reportedGeneration === null && rest.legacyStopKey
  if (!legacyKey) {
    return false
  }
  const dispatchId = workerTurnStopDispatchId(target)
  const id = stopReportId(dispatchId, legacyKey)
  return target.kind === 'local'
    ? db.getMessageById(id) !== undefined
    : hasRelayedWorkerReport(db, dispatchId, id)
}

function parseRest(report: string): StoredRest | null {
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only observeWorker writes this column, from a StoredRest.
    const rest = JSON.parse(report) as StoredRest
    return typeof rest?.from === 'string' && typeof rest.reason === 'string' ? rest : null
  } catch {
    return null
  }
}
