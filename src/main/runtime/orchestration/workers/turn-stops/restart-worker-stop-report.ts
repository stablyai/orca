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
import { listUndecidedWorkerRests } from '../../db/worker-presence/worker-presence-store'
import { potentiallyLiveRemoteAttachmentSql } from '../../db/federation/remote-attachment-liveness'
import type { DispatchContextRow } from '../../db/orchestration-records'

export type RestartWorkerStopReportDeps = {
  db: OrchestrationDb
  reportDeps: WorkerTurnStopReportDeps
  /** A terminal worker's pane at rest, reported as its live stop would have been. */
  reportRestingPane: (paneKey: string) => Promise<void>
  /** Opens a chat so its status is read from its journal; null when this host runs no chats. */
  chats: {
    /** Only these chats were cut by the run that just ended; no other worker chat is opened. */
    cutByLastRun: ReadonlySet<string>
    /** The /clear root a session continues, which its Dispatch names. */
    lineageRoot: (sessionId: string) => string
    open: (sessionId: string) => Promise<unknown>
    /** What the worker last said, for the report. */
    lastOutput: (sessionId: string) => string | undefined
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
  root: string
): Promise<void> {
  await chats.open(sessionId)
  const cut = await chats.cutOf(sessionId)
  const worker = cut
    ? [...chatWorkerDispatches(sessionId, deps.db), ...chatWorkerDispatches(root, deps.db)].find(
        (entry) => entry.dispatch.id === dispatchId
      )
    : undefined
  if (!cut || !worker) {
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
      // An agent a crash may have left running is not known to have exited, and mail could start a
      // second one beside it.
      gone: cut.exitUnproven
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
        cause: `${CUT_BY[cut.cause]}, and its restart offer was dismissed`,
        lastOutput: deps.lastOutput(sessionId)
      })
    }
  }
}

export async function reportWorkerStopsAcrossRestart(
  deps: RestartWorkerStopReportDeps
): Promise<void> {
  const { db, chats } = deps
  // Visits run side by side: one pane's screen read must not hold back another worker's report.
  const visits: Promise<void>[] = []
  const visit = (key: string, run: () => Promise<void> | void): void => {
    visits.push(
      Promise.resolve()
        .then(run)
        .catch((error: unknown) => {
          console.warn(
            '[orchestration] reporting a worker stopped across a restart failed',
            key,
            error
          )
        })
    )
  }
  // A Dispatch names its chat's /clear root; the cut names the successor that ran.
  const cutsByRoot = new Map<string, string[]>()
  for (const sessionId of chats?.cutByLastRun ?? []) {
    const root = chats?.lineageRoot(sessionId) ?? sessionId
    cutsByRoot.set(root, [...(cutsByRoot.get(root) ?? []), sessionId])
  }
  for (const dispatchId of openDispatchIds(db)) {
    // Re-read: an earlier report, a worker's own report or the terminal sweep may have closed it.
    const dispatch = db.getDispatchContextById(dispatchId)
    if (
      !dispatch ||
      (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') ||
      // Its brief may not have reached the worker yet, as the live report waits out too.
      db.getWorkerDispatch(dispatchId)?.state === 'starting'
    ) {
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
      if (chats) {
        visit(dispatchId, () => reportCutChat(deps, chats, dispatchId, cut, sessionId))
      }
    }
  }
  // A paired server's worker has only its attachment here.
  for (const paneKey of activeRemoteWorkerPanes(db)) {
    visit(paneKey, () => deps.reportRestingPane(paneKey))
  }
  await Promise.all(visits)
  // No wait for mail outlives a restart, so none holds back a rest any more.
  for (const dispatchId of listUndecidedWorkerRests(db)) {
    try {
      reconsiderWorkerRest(db, dispatchId, deps.reportDeps)
    } catch (error) {
      console.warn('[orchestration] reconsidering a worker rest failed', dispatchId, error)
    }
  }
}

function activeRemoteWorkerPanes(db: OrchestrationDb): string[] {
  return db.db
    .prepare(
      `SELECT DISTINCT pane_key FROM remote_dispatch_attachments
        WHERE ${potentiallyLiveRemoteAttachmentSql()} AND state != 'starting' AND pane_key IS NOT NULL`
    )
    .all()
    .flatMap((row) => (typeof row.pane_key === 'string' ? [row.pane_key] : []))
}
