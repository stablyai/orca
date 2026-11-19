import { createHash } from 'node:crypto'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { readCoordinatorMailCount } from '../../db/messages/dispatch-read-mail'
import { runLifecycleWriteTransaction } from '../../db/lifecycle-write-transaction-runner'
import { POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES } from '../../db/federation/remote-attachment-liveness'
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

const LIVE_ATTACHMENT_STATES: readonly string[] = POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES

// Kept with an undecided rest; the report shows only the end of it.
const STORED_OUTPUT_MAX_CHARS = 2_000

export type WorkerRest = Pick<
  WorkerTurnStop,
  | 'from'
  | 'lastOutput'
  | 'awaitsReply'
  | 'approval'
  | 'turnStartedAt'
  | 'mailTaken'
  | 'requestError'
> & { reason: 'finished' | 'errored' | 'needs-input' }

export type WorkerGone = Pick<
  WorkerTurnStop,
  'from' | 'lastOutput' | 'cause' | 'leftover' | 'neverStarted' | 'restartsOnMail'
> & { reason: 'exited' | 'lost' }

/** What an edge saw of its worker. `fence` names the rest: its process or chat turn and when it began,
 *  so the same rest seen twice is one fact and a new rest is another, even in the same presence. */
export type WorkerObservation =
  | {
      presence: 'working'
      /** A turn that began after the worker stopped, though nothing recorded the stop: a new fact. */
      newTurn?: true
    }
  | {
      presence: 'at-rest'
      fence: string
      rest: WorkerRest
      /** The key builds before the presence table gave this rest; its report must not go out twice. */
      legacyStopKey: string
      /** The whole id, for a report those builds did not key by a stop. */
      legacyReportId?: string
    }
  | {
      presence: 'gone'
      /** The process or provider that ended. A worker is gone once until it works again. */
      fence: string
      gone: WorkerGone
      legacyStopKey: string
      /** Settles the Dispatch in the same transaction as the report, which then names the outcome. */
      settle?: () => WorkerTurnStop['settled']
    }

type StoredRest = (WorkerRest | (WorkerGone & Pick<WorkerTurnStop, 'settled'>)) & {
  legacyStopKey: string
  legacyReportId?: string
}

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
    const fence = observation.newTurn ? `turn:${(current?.generation ?? 0) + 1}` : null
    const next = nextWorkerPresence(current, { presence: 'working', fence, report: null })
    if (next.changed) {
      writeWorkerPresence(db, dispatchId, next)
    }
    return false
  }
  if (observation.presence === 'gone') {
    // A worker whose Dispatch settled is gone for good, whichever edge sees it go next; one left open
    // (a chat that mail restarts) ends only the provider its fence names.
    const fence =
      current?.presence === 'gone' && !isDispatchOpen(db, target)
        ? current.fence
        : observation.fence
    return runLifecycleWriteTransaction(db.db, 'observe_worker_gone', () => {
      const settled = observation.settle?.()
      return reconcileWorkerReport(
        db,
        target,
        nextWorkerPresence(current, {
          presence: 'gone',
          fence,
          report: storedReport(
            { ...observation.gone, ...(settled ? { settled } : {}) },
            observation
          )
        }),
        deps
      )
    })
  }
  const { rest } = observation
  // Seen again, an undecided rest is decided again: what held it back may have cleared.
  const sent = reconcileWorkerReport(
    db,
    target,
    nextWorkerPresence(current, {
      presence: rest.reason === 'needs-input' ? 'prompt' : 'resting',
      fence: observation.fence,
      report: storedReport(rest, observation)
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

/** What held a rest back may have cleared without the worker moving (a wait for mail that ended, or
 *  a restart that dropped every wait): its stored rest is decided again. True when it went out now. */
export function reconsiderWorkerRest(
  db: OrchestrationDb,
  dispatchId: string,
  deps: WorkerTurnStopReportDeps
): boolean {
  const row = readWorkerPresence(db, dispatchId)
  const target = row?.report ? currentWorkerTarget(db, dispatchId) : null
  return row && target ? reconcileWorkerReport(db, target, { ...row, changed: false }, deps) : false
}

/** A worker's wait for mail that ended empty no longer holds back its rest. */
export function reconsiderRestAfterWait(mailbox: string, deps: WorkerTurnStopReportDeps): void {
  const db = deps.getDb()
  if (!db || !mailbox.startsWith('dispatch:')) {
    return
  }
  try {
    reconsiderWorkerRest(db, mailbox.slice('dispatch:'.length), deps)
  } catch (error) {
    console.warn('[orchestration] reconsidering a worker rest failed', mailbox, error)
  }
}

/** The open Dispatch, or the active attachment of a paired server's worker, whose worker this is. */
function currentWorkerTarget(
  db: OrchestrationDb,
  dispatchId: string
): WorkerTurnStopDispatch | null {
  const dispatch = db.getDispatchContextById(dispatchId)
  if (dispatch) {
    return dispatch.status === 'pending' || dispatch.status === 'dispatched'
      ? { kind: 'local', dispatch }
      : null
  }
  const attachment = db.getRemoteDispatchAttachment(dispatchId)
  return attachment && LIVE_ATTACHMENT_STATES.includes(attachment.state)
    ? { kind: 'remote', attachment }
    : null
}

/** A remote attachment settles at its Run home; this side sees only active ones. */
function isDispatchOpen(db: OrchestrationDb, target: WorkerTurnStopDispatch): boolean {
  if (target.kind === 'remote') {
    return true
  }
  const status = db.getDispatchContextById(target.dispatch.id)?.status
  return status === 'pending' || status === 'dispatched'
}

function storedReport(
  report: Omit<StoredRest, 'legacyStopKey' | 'legacyReportId'>,
  legacy: { legacyStopKey: string; legacyReportId?: string }
): string {
  const { lastOutput } = report
  return JSON.stringify({
    ...report,
    ...(lastOutput && lastOutput.length > STORED_OUTPUT_MAX_CHARS
      ? { lastOutput: lastOutput.slice(-STORED_OUTPUT_MAX_CHARS) }
      : {}),
    legacyStopKey: legacy.legacyStopKey,
    ...(legacy.legacyReportId ? { legacyReportId: legacy.legacyReportId } : {})
  })
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
    row.presence === 'working' ||
    (row.reportedGeneration ?? 0) >= row.generation
  ) {
    return keep()
  }
  const rest = parseRest(row.report)
  if (!rest) {
    writeWorkerPresence(db, dispatchId, decided(undefined))
    return false
  }
  // Left undecided: the same rest seen again is decided again. Going away, or a failed request the
  // chat showed, is never deliberate.
  if (
    rest.reason !== 'exited' &&
    rest.reason !== 'lost' &&
    !('requestError' in rest && rest.requestError) &&
    isDeliberateRest(db, target, rest, deps)
  ) {
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
  const id =
    'approval' in rest && rest.approval
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
      : !('approval' in rest && rest.approval) &&
        row.reportedGeneration === null &&
        rest.legacyStopKey
  if (!legacyKey) {
    return false
  }
  const dispatchId = workerTurnStopDispatchId(target)
  const id =
    finishedMail === undefined && rest.legacyReportId
      ? rest.legacyReportId
      : stopReportId(dispatchId, legacyKey)
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
