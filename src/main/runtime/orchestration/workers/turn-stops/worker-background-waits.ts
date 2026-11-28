import type { AgentPaneChange } from '../../../../agent-hooks/observations/agent-transition-detector'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import {
  agentBackgroundWait,
  agentLeadTurnFailedUnderChildWork
} from '../../../../../shared/agent-status/lifecycle/agent-background-wait'
import { structuredAgentSessionIdOfTab } from '../../../../../shared/agent-session/view/structured-agent-session-tab'
import { AGENT_DONE_QUIET_MS } from '../../../../../shared/agent-status/lifecycle/agent-transitions'
import { rowsShowWait } from './worker-background-wait-rows'
import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  readWorkerPresence,
  settleWorkerRestUnreported
} from '../../db/worker-presence/worker-presence-store'
import { chatWorkerDispatches } from './chat-worker-error-escalation'
import {
  chatWakesItselfOnBackgroundExit,
  heldTurnFinished,
  wakeChatWorkerAfterBackgroundExit
} from './chat-worker-background-wake'
import { resolveTerminalWorkerDispatch } from './terminal-worker-dispatch'
import { observeWorker } from './worker-presence-report'
import { terminalRequestError } from './terminal-request-error'
import {
  failedLeadTurnFence,
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
 *  Dispatch records that passive presence without waking the coordinator while the tasks run. */
export class WorkerBackgroundWaits {
  /** Panes last seen waiting, by the turn end they wait from: a repeat hook post is no new fact. */
  private readonly waitingSince = new Map<string, number>()
  /** Panes last seen with a failed lead turn under live children, by that turn's end. */
  private readonly failedSince = new Map<string, number>()
  /** What each waiting pane's background tasks run, for the wake that names them. */
  private readonly waitCommands = new Map<string, string[]>()

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
      // Seen again, a wait or failure that failed to record is recorded then.
      this.waitingSince.delete(change.paneKey)
      this.failedSince.delete(change.paneKey)
      this.waitCommands.delete(change.paneKey)
      console.warn('[orchestration] observing a worker background wait failed', error)
    }
  }

  /** Restores a recorded wait's tracking across a restart, or clears it once its pane moved on. */
  arm(db: OrchestrationDb, dispatchId: string): void {
    const recorded = recordedWait(db, dispatchId)
    if (!recorded) {
      return
    }
    const row = recorded.paneKey ? this.deps.readHookRow(recorded.paneKey) : null
    if (!rowsShowWait(row ? [row] : [], recorded)) {
      settleWorkerRestUnreported(db, dispatchId)
      return
    }
    if (recorded.paneKey) {
      this.waitingSince.set(recorded.paneKey, recorded.since)
    }
  }

  /** A terminal worker's lead turn failed while its children keep the pane working: no all-clear will
   *  come for it, so it is reported now, once per failed turn. True when the row shows such a turn. */
  reportFailedLeadTurn(
    paneKey: string,
    row: AgentStatusIpcPayload | null = this.deps.readHookRow(paneKey)
  ): boolean {
    const failed = row && !row.structuredHost ? agentLeadTurnFailedUnderChildWork(row) : null
    if (!row || !failed) {
      return false
    }
    if (this.failedSince.get(paneKey) === failed.since) {
      return true
    }
    const workers = this.workersOf(paneKey, row)
    const fence = failedLeadTurnFence(failed.since)
    const requestError = terminalRequestError(row)
    for (const worker of workers) {
      observeWorker(
        worker.db,
        worker.target,
        {
          presence: 'at-rest',
          fence,
          legacyStopKey: `${paneKey}:${fence}`,
          rest: {
            from: worker.from,
            reason: 'errored',
            turnStartedAt: row.turnStartedAt,
            lastOutput: requestError ? undefined : row.lastAssistantMessage,
            ...(requestError ? { requestError } : {})
          }
        },
        this.deps
      )
    }
    // Recorded only once its rest is: the lead's next turn then reads as the end of this rest, as a wait's does.
    if (workers.length > 0) {
      this.failedSince.set(paneKey, failed.since)
      this.waitingSince.set(paneKey, failed.since)
    }
    return true
  }

  private observePane(paneKey: string): void {
    const row = this.deps.readHookRow(paneKey)
    if (this.reportFailedLeadTurn(paneKey, row)) {
      return
    }
    this.failedSince.delete(paneKey)
    const wait = row ? agentBackgroundWait(row) : null
    if (wait) {
      if (this.waitingSince.get(paneKey) === wait.since) {
        return
      }
      const workers = this.workersOf(paneKey, row)
      // Seen again until a worker is found: a first sighting before its Dispatch resolves still counts.
      if (workers.length > 0) {
        this.waitingSince.set(paneKey, wait.since)
        this.waitCommands.set(paneKey, wait.commands)
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
      }
      return
    }
    const since = this.waitingSince.get(paneKey)
    if (since === undefined) {
      return
    }
    this.waitingSince.delete(paneKey)
    const commands = this.waitCommands.get(paneKey)
    this.waitCommands.delete(paneKey)
    // A chat whose tasks ended without waking it is idle now: its held finish is reported after the
    // quiet period a finish gets, unless the wake turn starts by then.
    if (row?.structuredHost && row.state === 'done') {
      this.deps.setTimer(() => this.reportChatFinish(paneKey, since), AGENT_DONE_QUIET_MS)
      if (!chatWakesItselfOnBackgroundExit(row.agentType)) {
        this.wakeChat(paneKey, row, { since, commands })
      }
      return
    }
    // Its lead took a turn again (a finished task woke it, or mail did): the wait is over. A rest,
    // a prompt or an exit is the other edges' own news.
    if (row?.state === 'working' && row.mainAgent?.state !== 'done') {
      for (const worker of this.workersOf(paneKey, row)) {
        observeWorker(worker.db, worker.target, { presence: 'working' }, this.deps)
      }
    }
  }

  /** This chat's agent won't take a turn for its ended tasks, so Orca starts one through its own mail. */
  private wakeChat(
    paneKey: string,
    row: AgentStatusIpcPayload,
    wait: { since: number; commands?: string[] }
  ): void {
    try {
      const sessionId = row.tabId ? structuredAgentSessionIdOfTab(row.tabId) : null
      // A task the person stopped ended by their hand: there's nothing for the agent to pick up.
      if (
        !heldTurnFinished(row, wait.since) ||
        (sessionId && this.deps.backgroundStopRequestedSince?.(sessionId, wait.since))
      ) {
        return
      }
      // One chat runs one turn: its first open Dispatch's mail starts it.
      const worker = this.finishedWorkersOf(paneKey, row)[0]
      if (worker?.target.kind === 'local') {
        wakeChatWorkerAfterBackgroundExit(worker.db, worker.target.dispatch, wait, this.deps)
      }
    } catch (error) {
      console.warn('[orchestration] waking a chat worker after its background task failed', error)
    }
  }

  /** Still idle on the same turn end, and not failed or cut: the held turn finished. */
  private reportChatFinish(paneKey: string, since: number): void {
    try {
      const row = this.deps.readHookRow(paneKey)
      if (!row || !heldTurnFinished(row, since)) {
        return
      }
      for (const worker of this.finishedWorkersOf(paneKey, row)) {
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

  /** Workers whose held turn is news: a Dispatch still starting has not run one. */
  private finishedWorkersOf(paneKey: string, row: AgentStatusIpcPayload): PaneWorker[] {
    return this.workersOf(paneKey, row).filter(
      (worker) =>
        worker.target.kind !== 'local' ||
        worker.db.getWorkerDispatch(worker.target.dispatch.id)?.state !== 'starting'
    )
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
