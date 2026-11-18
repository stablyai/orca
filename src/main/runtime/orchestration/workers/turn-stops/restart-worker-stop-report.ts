// A worker whose turn ended while Orca was down, or whose chat Orca did not continue, raised no live
// edge. One pass at startup reads each open Dispatch's worker once and reports it through the same
// turn-stop report, so its usual keys keep a worker the coordinator already heard about quiet.

import type { AgentSessionStatusSummary } from '../../../../../shared/agent-session/agent-session-wire'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { readCoordinatorMailCount } from '../../db/messages/dispatch-read-mail'
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
    status: (
      sessionId: string
    ) => Pick<AgentSessionStatusSummary, 'status' | 'lastAssistantMessage'> | undefined
  } | null
}

function openDispatchIds(db: OrchestrationDb): string[] {
  return db.db
    .prepare("SELECT id FROM dispatch_contexts WHERE status IN ('pending', 'dispatched')")
    .all()
    .flatMap((row) => (typeof row.id === 'string' ? [row.id] : []))
}

export async function reportWorkerStopsAcrossRestart(
  deps: RestartWorkerStopReportDeps
): Promise<void> {
  const { db } = deps
  for (const dispatchId of openDispatchIds(db)) {
    try {
      // Re-read: an earlier report, a worker's own report or the terminal sweep may have closed it.
      const dispatch = db.getDispatchContextById(dispatchId)
      if (!dispatch || (dispatch.status !== 'pending' && dispatch.status !== 'dispatched')) {
        continue
      }
      const sessionId = dispatch.assignee_orca_session_id
      if (!sessionId) {
        if (dispatch.assignee_pane_key) {
          await deps.reportRestingPane(dispatch.assignee_pane_key)
        }
        continue
      }
      if (!deps.chats) {
        continue
      }
      await deps.chats.open(sessionId)
      const status = deps.chats.status(sessionId)
      // Working (continued, or busy), or waiting on its person: not a stop to report.
      if (status?.status !== 'idle') {
        continue
      }
      const worker = chatWorkerDispatches(sessionId, db).find(
        (entry) => entry.dispatch.id === dispatchId
      )
      if (!worker) {
        continue
      }
      reportWorkerTurnStop(
        db,
        { kind: 'local', dispatch: worker.dispatch },
        {
          from: worker.from,
          reason: 'finished',
          mailTaken: readCoordinatorMailCount(db, dispatchId),
          lastOutput: status.lastAssistantMessage
        },
        deps.reportDeps
      )
    } catch (error) {
      console.warn(
        '[orchestration] reporting a worker stopped across a restart failed',
        dispatchId,
        error
      )
    }
  }
}
