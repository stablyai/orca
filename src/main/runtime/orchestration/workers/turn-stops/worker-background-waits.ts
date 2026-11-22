import type { AgentPaneChange } from '../../../../agent-hooks/observations/agent-transition-detector'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { agentBackgroundWait } from '../../../../../shared/agent-status/lifecycle/agent-background-wait'
import {
  structuredAgentSessionIdOfTab,
  structuredAgentSessionStatusPaneKey
} from '../../../../../shared/agent-session/view/structured-agent-session-tab'
import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  readWorkerPresence,
  settleWorkerRestUnreported
} from '../../db/worker-presence/worker-presence-store'
import { chatWorkerDispatches } from './chat-worker-error-escalation'
import { resolveTerminalWorkerDispatch } from './terminal-worker-turn-stops'
import { observeWorker, reconsiderWorkerRest } from './worker-presence-report'
import { workerBackgroundWaitDueAt } from './worker-background-wait-notice'
import {
  workerTurnStopDispatchId,
  type WorkerTurnStop,
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
    // A held turn's row is always working: a resting pane reads nothing unless it was waiting.
    const phase = change.kind === 'moved' ? change.to : change.phase
    if (phase !== 'working' && !this.waitingSince.has(change.paneKey)) {
      return
    }
    try {
      this.observePane(change.paneKey)
    } catch (error) {
      console.warn('[orchestration] observing a worker background wait failed', error)
    }
  }

  /** Re-arms a recorded wait's notice, as after a restart; a wait already due is decided now. */
  arm(db: OrchestrationDb, dispatchId: string): void {
    const recorded = recordedWait(db, dispatchId)
    if (!recorded) {
      return
    }
    // Its pane is waiting from that turn end, so the turn that ends the wait supersedes it.
    if (recorded.paneKey) {
      this.waitingSince.set(recorded.paneKey, recorded.since)
    }
    const dueAt = workerBackgroundWaitDueAt(recorded.since)
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
      const workers = this.workersOf(paneKey, row)
      // Seen again until a worker is found: a first sighting before its Dispatch resolves still counts.
      if (workers.length > 0) {
        this.waitingSince.set(paneKey, wait.since)
      }
      for (const worker of workers) {
        observeWorker(
          worker.db,
          worker.target,
          {
            presence: 'at-rest',
            // The turn end names the wait: a restart that remints the process id is the same wait.
            fence: `background:${wait.since}`,
            legacyStopKey: `${paneKey}:background:${wait.since}`,
            rest: {
              from: worker.from,
              reason: 'background-wait',
              backgroundWait: { ...wait, paneKey },
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
    const since = this.waitingSince.get(paneKey)
    if (since === undefined) {
      return
    }
    this.waitingSince.delete(paneKey)
    // A chat whose tasks ended without waking it is idle now: its held finish was never reported.
    if (row?.structuredHost && row.state === 'done') {
      for (const worker of this.workersOf(paneKey, row)) {
        observeWorker(
          worker.db,
          worker.target,
          {
            presence: 'at-rest',
            fence: `background-ended:${since}`,
            legacyStopKey: `${paneKey}:background-ended:${since}`,
            rest: { from: worker.from, reason: 'finished', lastOutput: row.lastAssistantMessage }
          },
          this.deps
        )
      }
      return
    }
    // Its lead took a turn again (a finished task woke it, or mail did): the wait is over. A rest,
    // a prompt or an exit is the other edges' own news.
    if (row && row.mainAgent?.state !== 'done' && row.state !== 'done') {
      for (const worker of this.workersOf(paneKey, row)) {
        observeWorker(worker.db, worker.target, { presence: 'working' }, this.deps)
        const dispatchId = workerTurnStopDispatchId(worker.target)
        this.timers.get(dispatchId)?.cancel()
        this.timers.delete(dispatchId)
      }
    }
  }

  /** A notice falls due: the stored rest decides, so a turn, worker_done, stop or exit since supersedes
   *  it; and its pane's row must still show this wait, whichever edge ended it unseen. A pane with no
   *  row yet (not restored) leaves the record to decide. */
  private decide(dispatchId: string): void {
    const db = this.deps.getDb()
    const recorded = db ? recordedWait(db, dispatchId) : null
    if (!db || !recorded) {
      return
    }
    try {
      const row = recorded.paneKey ? this.deps.readHookRow(recorded.paneKey) : null
      if (!rowsShowWait(row ? [row] : [], recorded.since)) {
        settleWorkerRestUnreported(db, dispatchId)
        return
      }
      reconsiderWorkerRest(db, dispatchId, this.deps)
    } catch (error) {
      console.warn('[orchestration] deciding a worker background wait failed', dispatchId, error)
    }
  }

  /** The open Dispatches this pane's worker runs: a terminal's by its handle, a chat's by its session. */
  private workersOf(paneKey: string, row: AgentStatusIpcPayload | null): PaneWorker[] {
    const sessionId =
      row?.structuredHost && row.tabId ? structuredAgentSessionIdOfTab(row.tabId) : null
    if (sessionId) {
      const db = this.deps.getDb()
      return db
        ? chatWorkerDispatches(sessionId, db).map(({ dispatch, from }) => ({
            db,
            target: { kind: 'local' as const, dispatch },
            from
          }))
        : []
    }
    const resolved = resolveTerminalWorkerDispatch(this.deps, paneKey)
    if (!resolved) {
      return []
    }
    return [{ db: resolved.db, target: resolved.target, from: resolved.handle }]
  }
}

/** A Dispatch's undecided background wait: its turn end and pane; null for any other rest. */
function recordedWait(
  db: OrchestrationDb,
  dispatchId: string
): { since: number; paneKey?: string } | null {
  const row = readWorkerPresence(db, dispatchId)
  if (!row?.report || row.presence !== 'resting') {
    return null
  }
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only observeWorker writes this column, from a stored rest; every field is checked below.
    const rest = JSON.parse(row.report) as Partial<WorkerTurnStop> | null
    const wait = rest?.reason === 'background-wait' ? rest.backgroundWait : undefined
    return typeof wait?.since === 'number'
      ? {
          since: wait.since,
          ...(typeof wait.paneKey === 'string' ? { paneKey: wait.paneKey } : {})
        }
      : null
  } catch {
    // An unreadable rest is decided by the presence report itself.
    return null
  }
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

/** No row yet (a pane not restored) proves nothing; a row that names another turn ends the wait. */
function rowsShowWait(rows: readonly AgentStatusIpcPayload[], since: number): boolean {
  return rows.length === 0 || rows.some((row) => agentBackgroundWait(row)?.since === since)
}

/** Whether a recorded wait's pane still shows it, by this host's status rows. */
export function backgroundWaitShown(
  rows: { getStatusSnapshotForPane: (paneKey: string) => readonly AgentStatusIpcPayload[] },
  wait: { since: number; paneKey?: string }
): boolean {
  return !wait.paneKey || rowsShowWait(rows.getStatusSnapshotForPane(wait.paneKey), wait.since)
}
