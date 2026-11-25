// A worker whose turn ended while Orca was down, or whose chat the run that just ended cut and Orca did
// not continue, raised no live edge. One pass at startup observes each as a live edge would: a terminal
// as its live stop, so a rest already reported is not reported again, and a chat as the restart left it.
// Other chats are not opened.

import type { OrchestrationDb } from '../../db/orchestration-db'
import type {
  StructuredAgentSessionRestartCut,
  StructuredAgentSessionRestartResume
} from '../../../../native-chat/agent-session-wire/recovery/structured-agent-session-restart-resume-contract'
import { chatWorkerDispatches } from './chat-worker-error-escalation'
import type { WorkerTurnStopReportDeps } from './worker-turn-stop-report'
import { observeWorker, reconsiderWorkerRest } from './worker-presence-report'
import {
  listUndecidedWorkerRests,
  readWorkerPresence
} from '../../db/worker-presence/worker-presence-store'
import { isWorkerStartOrStopUndecided } from '../lifecycle/worker-exit-observation'
import type { DispatchContextRow } from '../../db/orchestration-records'

export type RestartWorkerStopReportDeps = {
  db: OrchestrationDb
  reportDeps: WorkerTurnStopReportDeps
  /** A terminal worker's pane at rest, reported as its live stop would have been. */
  reportRestingPane: (paneKey: string) => Promise<void>
  /** A start whose turn was never seen begin, or that the restart cut, reported once. */
  reportUnconfirmedStart: (dispatchId: string) => Promise<void>
  /** Re-arms the notice of a recorded background wait from its turn end; others are left alone. */
  armBackgroundWait?: (dispatchId: string) => void
  /** A terminal worker resuming after the restart reports for itself once it runs again. */
  resuming?: (dispatchId: string) => boolean
  /** Opens a chat so its status is read from its journal; null when this host runs no chats. */
  chats: {
    /** Only these chats were cut by the run that just ended; no other worker chat is opened. */
    cutByLastRun: ReadonlySet<string>
    /** The /clear root a session continues, which its Dispatch names. */
    lineageRoot: (sessionId: string) => string
    open: (sessionId: string) => Promise<unknown>
    /** What the worker last said, for the report. */
    lastOutput: (sessionId: string) => string | undefined
    offeredCuts: StructuredAgentSessionRestartResume['offeredCuts']
    cutOf: StructuredAgentSessionRestartResume['cutOf']
  } | null
}

const CUT_BY: Record<StructuredAgentSessionRestartCut['cause'], string> = {
  crash: 'Orca crashed during its turn',
  quit: 'Orca quit during its turn',
  update: 'Orca restarted to update during its turn'
}

function openDispatchIds(db: OrchestrationDb): string[] {
  return db.db
    .prepare("SELECT id FROM dispatch_contexts WHERE status IN ('pending', 'dispatched')")
    .all()
    .flatMap((row) => (typeof row.id === 'string' ? [row.id] : []))
}

/** A chat worker Orca did not continue: reported as the restart left it, never as an idle finish. */
async function reportCutChat(
  deps: RestartWorkerStopReportDeps,
  chats: NonNullable<RestartWorkerStopReportDeps['chats']>,
  dispatchId: string,
  sessionId: string,
  root: string,
  offered: ReadonlyMap<string, StructuredAgentSessionRestartCut>,
  /** The worker's generation before the offers were read. */
  seen: number | undefined
): Promise<void> {
  await chats.open(sessionId)
  const cut = await chats.cutOf(sessionId, offered)
  const worker = cut
    ? [...chatWorkerDispatches(sessionId, deps.db), ...chatWorkerDispatches(root, deps.db)].find(
        (entry) => entry.dispatch.id === dispatchId
      )
    : undefined
  // Any turn or rest observed since the offers were read supersedes the cut.
  const now = readWorkerPresence(deps.db, dispatchId)
  if (!cut || !worker || now?.generation !== seen) {
    return
  }
  const lastOutput = chats.lastOutput(sessionId)
  const target = { kind: 'local' as const, dispatch: worker.dispatch }
  if (cut.waitingOnPerson) {
    // A rest of its own: the restart cancelled the prompt its live report said to wait on.
    const fence = `restart-prompt:${cut.turnId}`
    observeWorker(
      deps.db,
      target,
      {
        presence: 'at-rest',
        fence,
        legacyStopKey: fence,
        rest: { from: worker.from, reason: 'needs-input', lastOutput }
      },
      deps.reportDeps
    )
    return
  }
  observeCutWorkerGone(deps, target, sessionId, cut, {
    from: worker.from,
    cause: `${CUT_BY[cut.cause]}; its chat is kept and can be continued`,
    lastOutput
  })
}

/** The cut ended the worker's provider; mail starts its chat again. A startup report and a dismissal
 *  of the same cut are one fact. */
function observeCutWorkerGone(
  deps: Pick<RestartWorkerStopReportDeps, 'db' | 'reportDeps'>,
  target: { kind: 'local'; dispatch: DispatchContextRow },
  sessionId: string,
  cut: StructuredAgentSessionRestartCut,
  gone: { from: string; cause: string; lastOutput: string | undefined }
): void {
  const fence = `cut:${sessionId}:${cut.turnId}`
  observeWorker(
    deps.db,
    target,
    {
      presence: 'gone',
      fence,
      legacyStopKey: fence,
      // An agent a crash may have left running, or that may have taken its continuation, is not known
      // to have exited, and mail could start a second one beside it.
      gone:
        cut.exitUnproven || cut.continuationUnconfirmed
          ? { ...gone, reason: 'lost', cause: `${gone.cause}; its agent may still be running` }
          : { ...gone, reason: 'exited', restartsOnMail: true }
    },
    deps.reportDeps
  )
}

/** A person dismissed these chats' restart offers: their work is abandoned, so each worker's
 *  coordinator is told once, as the same fact a startup report of that cut observed. */
export function reportDismissedCutWorkers(
  deps: Pick<RestartWorkerStopReportDeps, 'db' | 'reportDeps'> & {
    lastOutput: (sessionId: string) => string | undefined
  },
  dismissed: readonly { sessionId: string; cut: StructuredAgentSessionRestartCut }[]
): void {
  for (const { sessionId, cut } of dismissed) {
    for (const worker of chatWorkerDispatches(sessionId, deps.db)) {
      observeCutWorkerGone(deps, { kind: 'local', dispatch: worker.dispatch }, sessionId, cut, {
        from: worker.from,
        cause: cut.continuationUnconfirmed
          ? `${CUT_BY[cut.cause]}; Orca asked its agent to continue but never saw it start, and its restart offer was dismissed`
          : `${CUT_BY[cut.cause]}, and its restart offer was dismissed`,
        lastOutput: deps.lastOutput(sessionId)
      })
    }
  }
}

export async function reportWorkerStopsAcrossRestart(
  deps: RestartWorkerStopReportDeps
): Promise<void> {
  const { db, chats } = deps
  // Visits run side by side, and each Dispatch's own wait only on its visit: one pane's screen read
  // must not hold back another worker's report.
  const visits = new Map<string, Promise<void>>()
  const visit = (dispatchId: string, run: () => Promise<void> | void): void => {
    const previous = visits.get(dispatchId) ?? Promise.resolve()
    visits.set(
      dispatchId,
      previous.then(run).catch((error: unknown) => {
        console.warn(
          '[orchestration] reporting a worker stopped across a restart failed',
          dispatchId,
          error
        )
      })
    )
  }
  // Fenced before the offers are read: a continuation that starts during the read supersedes its cut.
  const seen = new Map(
    openDispatchIds(db).map((id) => [id, readWorkerPresence(db, id)?.generation] as const)
  )
  // Unread offers leave every chat to a person; terminals are decided all the same.
  const offered = chats
    ? await chats.offeredCuts().catch((error: unknown) => {
        console.warn('[orchestration] reading restart offers failed', error)
        return null
      })
    : new Map<string, StructuredAgentSessionRestartCut>()
  const root = (sessionId: string) => chats?.lineageRoot(sessionId) ?? sessionId
  // A Dispatch names its chat's /clear root; the cut names the successor that ran.
  const cutsByRoot = new Map<string, string[]>()
  for (const sessionId of chats?.cutByLastRun ?? []) {
    cutsByRoot.set(root(sessionId), [...(cutsByRoot.get(root(sessionId)) ?? []), sessionId])
  }
  // A chat whose cut still waits on a person's decision stays silent until that person acts.
  const awaitingDecision = offered && new Set([...offered.keys()].map(root))
  for (const dispatchId of openDispatchIds(db)) {
    // Re-read: an earlier report, a worker's own report or the terminal sweep may have closed it.
    const dispatch = db.getDispatchContextById(dispatchId)
    if (!dispatch || (dispatch.status !== 'pending' && dispatch.status !== 'dispatched')) {
      continue
    }
    const state = db.getWorkerDispatch(dispatchId)?.state
    // No receipt outlives a restart: a start still undecided is decided now, as its live report would be.
    if (state === 'starting' || state === 'start_unknown') {
      visit(dispatchId, () => deps.reportUnconfirmedStart(dispatchId))
      continue
    }
    // A stop its coordinator asked for is no news, nor is a worker resuming after the restart.
    if (isWorkerStartOrStopUndecided(state) || deps.resuming?.(dispatchId)) {
      continue
    }
    const sessionId = dispatch.assignee_orca_session_id
    const paneKey = dispatch.assignee_pane_key
    if (!sessionId) {
      if (paneKey) {
        visit(dispatchId, () => deps.reportRestingPane(paneKey))
      }
      continue
    }
    for (const cut of cutsByRoot.get(sessionId) ?? []) {
      if (chats && offered) {
        visit(dispatchId, () =>
          reportCutChat(deps, chats, dispatchId, cut, sessionId, offered, seen.get(dispatchId))
        )
      }
    }
  }
  // A paired server's worker has only its attachment here.
  for (const { dispatchId, paneKey } of readyRemoteWorkers(db)) {
    visit(dispatchId, () => deps.reportRestingPane(paneKey))
  }
  // No wait for mail outlives a restart, so none holds back a rest any more.
  for (const dispatchId of listUndecidedWorkerRests(db)) {
    if (deps.resuming?.(dispatchId)) {
      continue
    }
    deps.armBackgroundWait?.(dispatchId)
    const session = db.getDispatchContextById(dispatchId)?.assignee_orca_session_id
    if (!session || (awaitingDecision && !awaitingDecision.has(session))) {
      visit(dispatchId, () => void reconsiderWorkerRest(db, dispatchId, deps.reportDeps))
    }
  }
  await Promise.all(visits.values())
}

/** Workers on this paired server that are running, not starting or being stopped. */
function readyRemoteWorkers(db: OrchestrationDb): { dispatchId: string; paneKey: string }[] {
  return db.db
    .prepare(
      `SELECT dispatch_id, pane_key FROM remote_dispatch_attachments
        WHERE state = 'ready' AND pane_key IS NOT NULL`
    )
    .all()
    .flatMap((row) =>
      typeof row.dispatch_id === 'string' && typeof row.pane_key === 'string'
        ? [{ dispatchId: row.dispatch_id, paneKey: row.pane_key }]
        : []
    )
}
