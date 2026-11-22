import type { AgentPaneChange } from '../../../../agent-hooks/observations/agent-transition-detector'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { agentBackgroundWait } from '../../../../../shared/agent-status/lifecycle/agent-background-wait'
import {
  structuredAgentSessionIdOfTab,
  structuredAgentSessionStatusPaneKey
} from '../../../../../shared/agent-session/view/structured-agent-session-tab'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { readWorkerPresence } from '../../db/worker-presence/worker-presence-store'
import { chatWorkerDispatches } from './chat-worker-error-escalation'
import { resolveTerminalWorkerDispatch } from './terminal-worker-turn-stops'
import { observeWorker, reconsiderWorkerRest } from './worker-presence-report'
import { workerBackgroundWaitDueAt } from './worker-background-wait-notice'
import {
  workerTurnStopDispatchId,
  type WorkerTurnStopDispatch,
  type WorkerTurnStopReportDeps
} from './worker-turn-stop-report'

export type WorkerBackgroundWaitsDeps = WorkerTurnStopReportDeps & {
  readHookRow: (paneKey: string) => AgentStatusIpcPayload | null
  getHandle: (paneKey: string) => string | null
  getProcessIncarnation: (handle: string) => string | null
  setTimer: (run: () => void, delayMs: number) => { cancel: () => void }
}

type PaneWorker = {
  db: OrchestrationDb
  target: WorkerTurnStopDispatch
  from: string
  fence: string
}

/** A worker whose turn ended while its own background tasks still run is waiting, not stopped: its
 *  Dispatch records that rest at once, and it becomes news once, when no turn has started by the bound.
 *  One timer per waiting Dispatch, armed from the recorded turn end, so a restart re-arms the same one. */
export class WorkerBackgroundWaits {
  /** Panes last seen waiting, by the turn end they wait from: a repeat hook post is no new fact. */
  private readonly waitingSince = new Map<string, number>()
  private readonly timers = new Map<string, { dueAt: number; cancel: () => void }>()

  constructor(private readonly deps: WorkerBackgroundWaitsDeps) {}

  observe(change: AgentPaneChange): void {
    try {
      this.observePane(change.paneKey)
    } catch (error) {
      console.warn('[orchestration] observing a worker background wait failed', error)
    }
  }

  /** Re-arms a recorded wait's notice, as after a restart; a wait already due is decided now. */
  arm(db: OrchestrationDb, dispatchId: string): void {
    const since = recordedWaitSince(db, dispatchId)
    if (since === null) {
      return
    }
    const dueAt = workerBackgroundWaitDueAt(since)
    if (this.timers.get(dispatchId)?.dueAt === dueAt) {
      return
    }
    this.timers.get(dispatchId)?.cancel()
    const timer = this.deps.setTimer(
      () => {
        this.timers.delete(dispatchId)
        this.decide(dispatchId)
      },
      Math.max(0, dueAt - Date.now())
    )
    this.timers.set(dispatchId, { dueAt, cancel: timer.cancel })
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      timer.cancel()
    }
    this.timers.clear()
    this.waitingSince.clear()
  }

  private observePane(paneKey: string): void {
    const row = this.deps.readHookRow(paneKey)
    const wait = row ? agentBackgroundWait(row) : null
    if (wait) {
      if (this.waitingSince.get(paneKey) === wait.since) {
        return
      }
      this.waitingSince.set(paneKey, wait.since)
      for (const worker of this.workersOf(paneKey, row, wait.since)) {
        observeWorker(
          worker.db,
          worker.target,
          {
            presence: 'at-rest',
            fence: worker.fence,
            legacyStopKey: `${paneKey}:background:${wait.since}`,
            rest: {
              from: worker.from,
              reason: 'background-wait',
              backgroundWait: wait,
              lastOutput: row?.lastAssistantMessage,
              turnStartedAt: row?.turnStartedAt
            }
          },
          this.deps
        )
        this.arm(worker.db, workerTurnStopDispatchId(worker.target))
      }
      return
    }
    if (!this.waitingSince.delete(paneKey)) {
      return
    }
    // Its lead took a turn again (a finished task woke it, or mail did): the wait is over. A rest,
    // a prompt or an exit is the other edges' own news.
    if (row && row.mainAgent?.state !== 'done' && row.state !== 'done') {
      for (const worker of this.workersOf(paneKey, row, null)) {
        observeWorker(worker.db, worker.target, { presence: 'working' }, this.deps)
      }
    }
  }

  /** A notice falls due: the stored rest decides, so a turn, worker_done, stop or exit since supersedes it. */
  private decide(dispatchId: string): void {
    const db = this.deps.getDb()
    if (!db) {
      return
    }
    try {
      reconsiderWorkerRest(db, dispatchId, this.deps)
    } catch (error) {
      console.warn('[orchestration] deciding a worker background wait failed', dispatchId, error)
    }
  }

  /** The open Dispatches this pane's worker runs: a terminal's by its handle, a chat's by its session. */
  private workersOf(
    paneKey: string,
    row: AgentStatusIpcPayload | null,
    since: number | null
  ): PaneWorker[] {
    const sessionId =
      row?.structuredHost && row.tabId ? structuredAgentSessionIdOfTab(row.tabId) : null
    if (sessionId) {
      const db = this.deps.getDb()
      return db
        ? chatWorkerDispatches(sessionId, db).map(({ dispatch, from }) => ({
            db,
            target: { kind: 'local' as const, dispatch },
            from,
            fence: `background:${sessionId}:${since}`
          }))
        : []
    }
    const resolved = resolveTerminalWorkerDispatch(this.deps, paneKey)
    if (!resolved) {
      return []
    }
    // A relaunched agent in the same pane is a new process, whatever its hook clock says.
    const incarnation = this.deps.getProcessIncarnation(resolved.handle) ?? resolved.handle
    return [
      {
        db: resolved.db,
        target: resolved.target,
        from: resolved.handle,
        fence: `background:${incarnation}:${since}`
      }
    ]
  }
}

/** The turn end a Dispatch's undecided background wait counts from; null for any other rest. */
function recordedWaitSince(db: OrchestrationDb, dispatchId: string): number | null {
  const row = readWorkerPresence(db, dispatchId)
  if (!row?.report || row.presence !== 'resting') {
    return null
  }
  try {
    const rest: unknown = JSON.parse(row.report)
    if (
      rest &&
      typeof rest === 'object' &&
      'reason' in rest &&
      rest.reason === 'background-wait' &&
      'backgroundWait' in rest &&
      rest.backgroundWait &&
      typeof rest.backgroundWait === 'object' &&
      'since' in rest.backgroundWait &&
      typeof rest.backgroundWait.since === 'number'
    ) {
      return rest.backgroundWait.since
    }
  } catch {
    // An unreadable rest is decided by the presence report itself.
  }
  return null
}

/** A chat whose turn its own background tasks hold open, by its status row. */
export function chatWaitsOnBackground(
  rows: { getStatusSnapshotForPane: (paneKey: string) => readonly AgentStatusIpcPayload[] },
  sessionId: string
): boolean {
  return rows
    .getStatusSnapshotForPane(structuredAgentSessionStatusPaneKey(sessionId))
    .some((row) => agentBackgroundWait(row) !== null)
}
