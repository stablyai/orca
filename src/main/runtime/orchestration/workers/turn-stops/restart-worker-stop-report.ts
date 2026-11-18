// A worker whose turn ended while Orca was down, or whose chat a restart cut and Orca did not continue,
// raised no live edge. One pass at startup reads each open Dispatch's worker once and reports it
// through the same turn-stop report: a terminal as its live stop, a chat as the restart left it.

import type { AgentSessionStatusSummary } from '../../../../../shared/agent-session/agent-session-wire'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type {
  StructuredAgentSessionRestartCut,
  StructuredAgentSessionRestartResume
} from '../../../../native-chat/agent-session-wire/recovery/structured-agent-session-restart-resume-contract'
import { chatWorkerDispatches } from './chat-worker-error-escalation'
import { reportWorkerTurnStop, type WorkerTurnStopReportDeps } from './worker-turn-stop-report'

export type RestartWorkerStopReportDeps = {
  db: OrchestrationDb
  reportDeps: WorkerTurnStopReportDeps
  /** A terminal worker's pane at rest, reported as its live stop would have been. */
  reportRestingPane: (paneKey: string) => Promise<void>
  /** Opens a chat so its status is read from its journal; null when this host runs no chats. */
  chats: {
    open: (sessionId: string) => Promise<unknown>
    /** Read from the journal, not the status the last run saved. */
    status: (
      sessionId: string
    ) => Promise<Pick<AgentSessionStatusSummary, 'status' | 'lastAssistantMessage'> | undefined>
    cutOf: StructuredAgentSessionRestartResume['cutOf']
  } | null
}

const CUT_BY: Record<StructuredAgentSessionRestartCut['cause'], string> = {
  crash: 'Orca crashed during its turn; its chat is kept and can be continued',
  quit: 'Orca quit during its turn; its chat is kept and can be continued',
  update: 'Orca restarted to update during its turn; its chat is kept and can be continued'
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
  sessionId: string
): Promise<void> {
  await chats.open(sessionId)
  const status = await chats.status(sessionId)
  // Working again (continued, or busy): its own next stop reports it.
  const cut = status?.status === 'working' ? null : await chats.cutOf(sessionId)
  const worker = cut
    ? chatWorkerDispatches(sessionId, deps.db).find((entry) => entry.dispatch.id === dispatchId)
    : undefined
  if (!cut || !worker) {
    return
  }
  const lastOutput = status?.lastAssistantMessage
  reportWorkerTurnStop(
    deps.db,
    { kind: 'local', dispatch: worker.dispatch },
    cut.waitingOn
      ? {
          from: worker.from,
          reason: 'needs-input',
          // The key its live report used, so a prompt already reported stays quiet.
          stopKey: cut.waitingOn.promptItemId
            ? `prompt:${cut.waitingOn.promptItemId}`
            : `turn:${cut.turnId}`,
          lastOutput
        }
      : { from: worker.from, reason: 'exited', cause: CUT_BY[cut.cause], lastOutput },
    deps.reportDeps
  )
}

export async function reportWorkerStopsAcrossRestart(
  deps: RestartWorkerStopReportDeps
): Promise<void> {
  const { db } = deps
  for (const dispatchId of openDispatchIds(db)) {
    try {
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
      if (!sessionId) {
        if (dispatch.assignee_pane_key) {
          await deps.reportRestingPane(dispatch.assignee_pane_key)
        }
        continue
      }
      if (deps.chats) {
        await reportCutChat(deps, deps.chats, dispatchId, sessionId)
      }
    } catch (error) {
      console.warn(
        '[orchestration] reporting a worker stopped across a restart failed',
        dispatchId,
        error
      )
    }
  }
}
