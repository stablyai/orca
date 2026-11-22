import type { AgentPaneChange } from '../../../../agent-hooks/observations/agent-transition-detector'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { agentBackgroundWait } from '../../../../../shared/agent-status/lifecycle/agent-background-wait'
import { structuredAgentSessionIdOfTab } from '../../../../../shared/agent-session/view/structured-agent-session-tab'
import { AGENT_DONE_QUIET_MS } from '../../../../../shared/agent-status/lifecycle/agent-transitions'
import { rowsShowWait } from './worker-background-wait-rows'
import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  readWorkerPresence,
  settleWorkerRestUnreported
} from '../../db/worker-presence/worker-presence-store'
import { chatWorkerDispatches } from './chat-worker-error-escalation'
import { resolveTerminalWorkerDispatch } from './terminal-worker-dispatch'
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

const SEND_RETRIES = 3
const SEND_RETRY_MS = 60_000

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
      // Seen again, a wait that failed to record is recorded then.
      this.waitingSince.delete(change.paneKey)
      console.warn('[orchestration] observing a worker background wait failed', error)
    }
  }

  /** Re-arms a recorded wait's notice, as after a restart; a wait already due is decided now. */
  arm(db: OrchestrationDb, dispatchId: string, retries = SEND_RETRIES): void {
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
        this.decide(dispatchId, retries)
      },
      Math.max(0, dueAt - Date.now())
    )
    this.timers.set(dispatchId, { dueAt, cancel: timer.cancel })
  }

  /** A notice still undecided past its bound (its send failed, or a deliberate reason holds it) is
   *  decided again a few times, a minute apart; its own edges decide it after that. */
  private retry(db: OrchestrationDb, dispatchId: string, retries: number): void {
    if (!recordedWait(db, dispatchId)) {
      return
    }
    const timer = this.deps.setTimer(() => {
      this.timers.delete(dispatchId)
      this.decide(dispatchId, retries)
    }, SEND_RETRY_MS)
    this.timers.set(dispatchId, { dueAt: Date.now() + SEND_RETRY_MS, cancel: timer.cancel })
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
              backgroundWait: { ...wait, paneKey, ...(row?.structuredHost ? { chat: true } : {}) },
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
    // A chat whose tasks ended without waking it is idle now: its held finish is reported after the
    // quiet period a finish gets, unless the wake turn starts by then.
    if (row?.structuredHost && row.state === 'done') {
      this.deps.setTimer(() => this.reportChatFinish(paneKey, since), AGENT_DONE_QUIET_MS)
      return
    }
    // Its lead took a turn again (a finished task woke it, or mail did): the wait is over. A rest,
    // a prompt or an exit is the other edges' own news.
    if (row?.state === 'working' && row.mainAgent?.state !== 'done') {
      for (const worker of this.workersOf(paneKey, row)) {
        observeWorker(worker.db, worker.target, { presence: 'working' }, this.deps)
        const dispatchId = workerTurnStopDispatchId(worker.target)
        this.timers.get(dispatchId)?.cancel()
        this.timers.delete(dispatchId)
      }
    }
  }

  /** Still idle on the same turn end, and not failed or cut: the held turn finished. */
  private reportChatFinish(paneKey: string, since: number): void {
    try {
      const row = this.deps.readHookRow(paneKey)
      const lead = row?.mainAgent
      if (
        row?.state !== 'done' ||
        lead?.stateStartedAt !== since ||
        (lead.outcome !== undefined && lead.outcome !== 'success')
      ) {
        return
      }
      for (const worker of this.workersOf(paneKey, row)) {
        const dispatch = worker.target.kind === 'local' ? worker.target.dispatch : null
        if (dispatch && worker.db.getWorkerDispatch(dispatch.id)?.state === 'starting') {
          continue
        }
        observeWorker(
          worker.db,
          worker.target,
          {
            presence: 'at-rest',
            fence: `background-ended:${since}`,
            legacyStopKey: `${paneKey}:background-ended:${since}`,
            rest: {
              from: worker.from,
              reason: 'finished',
              lastOutput: row.lastAssistantMessage,
              turnStartedAt: row.turnStartedAt
            }
          },
          this.deps
        )
      }
    } catch (error) {
      console.warn('[orchestration] reporting a chat background finish failed', error)
    }
  }

  /** A notice falls due: the stored rest decides, so a turn, worker_done, stop or exit since supersedes
   *  it; and its pane's row must still show this wait, whichever edge ended it unseen. A pane with no
   *  row yet (not restored) leaves the record to decide. */
  private decide(dispatchId: string, retries: number): void {
    const db = this.deps.getDb()
    const recorded = db ? recordedWait(db, dispatchId) : null
    if (!db || !recorded) {
      return
    }
    try {
      const row = recorded.paneKey ? this.deps.readHookRow(recorded.paneKey) : null
      if (!rowsShowWait(row ? [row] : [], recorded)) {
        settleWorkerRestUnreported(db, dispatchId)
        return
      }
      if (!reconsiderWorkerRest(db, dispatchId, this.deps) && retries > 0) {
        this.retry(db, dispatchId, retries - 1)
      }
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
): { since: number; paneKey?: string; chat?: true } | null {
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
          ...(typeof wait.paneKey === 'string' ? { paneKey: wait.paneKey } : {}),
          ...(wait.chat === true ? { chat: true as const } : {})
        }
      : null
  } catch {
    // An unreadable rest is decided by the presence report itself.
    return null
  }
}
