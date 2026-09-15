import {
  WORKER_TERMINAL_LIST_STATES,
  type WorkerTerminalListState
} from '../../shared/worker-terminal-list-state'
import type { AgentStatus } from '../../shared/agent-detection'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { getAppEnvironment } from '../../shared/app-environment'
import type {
  RuntimeServeStatsAgentState,
  RuntimeServeStatsResult
} from '../../shared/runtime-types'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { collectServeStatsBrowserPages } from './serve-stats-browser-pages'
import { readServeStatsEventLoopDelayP99Ms } from './serve-stats-event-loop-delay'
import { collectServeStatsHost } from './serve-stats-host'
import { selectFreshExplicitAgentStatus } from './runtime-hook-agent-row-selection'
import { deriveServeStatsAgentState, getLatestPtyTitle } from './runtime-worktree-status-projection'
import { observeStructuredWorker } from './structured-worker-authority'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

export type ServeStatsPtyRecord = Pick<
  RuntimePtyWorktreeRecord,
  | 'ptyId'
  | 'paneKey'
  | 'connected'
  | 'launchAgent'
  | 'foregroundAgent'
  | 'lastAgentStatus'
  | 'lastAgentStatusObservedLive'
  | 'title'
  | 'titleUpdatedAt'
  | 'lastOscTitle'
  | 'lastOscTitleAt'
>

export type ServeStatsRuntime = {
  listManagedWorktrees(): Promise<{ totalCount: number }>
  getOrchestrationDb(): {
    countTasks(): number
    countTasksByStatus(): RuntimeServeStatsResult['counts']['tasksByStatus']
    countWorkerTerminalInventory(): { counts: Record<string, number> }
  }
  ptysById: Map<string, ServeStatsPtyRecord>
  getPtyLivenessVerdict(ptyId: string): { status: string } | null | undefined
  resolvePaneAgentIdentityField(
    launchAgent: unknown,
    foregroundAgent: unknown,
    title: string | null,
    paneKey: string | null
  ): { agentIdentity: unknown }
  handleByPtyId: Map<string, string>
  agentPromptExplicitStatusFloorByPtyId: Map<string, number>
  agentPromptLifecycleByPtyId: Map<
    string,
    { status: AgentStatus | null; workingSequence?: number; updatedAt: number }
  >
  getAgentStatusSnapshotFn?: () => readonly AgentStatusIpcPayload[]
  agentBrowserBridge?: Parameters<typeof collectServeStatsBrowserPages>[1]
  getRuntimeId(): string
  startedAt: number
  servePort: number | null
  longPollStatsProvider?: (() => RuntimeServeStatsResult['health']['longPolls']) | null
}

/**
 * One connected pty's turn state, from maps this process already holds.
 *
 * The explicit hook status is keyed by pane, and the lifecycle tracker by pty id, so neither
 * needs a terminal handle, a syscall, or a DB read; a pty with no current evidence stays
 * `unknown` rather than borrowing a plausible state.
 */
export function resolveServeStatsPtyAgentState(
  runtime: Pick<
    ServeStatsRuntime,
    'handleByPtyId' | 'agentPromptExplicitStatusFloorByPtyId' | 'agentPromptLifecycleByPtyId'
  >,
  pty: {
    ptyId: string
    paneKey: string | null
    lastAgentStatus: AgentStatus | null
    lastAgentStatusObservedLive: boolean
  },
  hookRows: readonly AgentStatusIpcPayload[]
): RuntimeServeStatsAgentState {
  const explicit = pty.paneKey
    ? selectFreshExplicitAgentStatus({
        handle: runtime.handleByPtyId.get(pty.ptyId) ?? null,
        paneKey: pty.paneKey,
        hookRows
      })
    : null
  const floor = runtime.agentPromptExplicitStatusFloorByPtyId.get(pty.ptyId)
  return deriveServeStatsAgentState({
    // Why: a status recorded before the last prompt submission is superseded evidence.
    explicit: explicit && (floor === undefined || explicit.updatedAt > floor) ? explicit : null,
    lifecycle: runtime.agentPromptLifecycleByPtyId.get(pty.ptyId),
    titleStatus: pty.lastAgentStatus,
    titleStatusObservedLive: pty.lastAgentStatusObservedLive
  })
}

// Occupancy follows runtime PTYs; turn-duration statistics exclude waiting agents.
export async function collectRuntimeServeStats(
  runtime: ServeStatsRuntime
): Promise<RuntimeServeStatsResult> {
  const worktrees = await runtime.listManagedWorktrees()
  const db = runtime.getOrchestrationDb()
  const tasks = db.countTasks()
  const tasksByStatus = db.countTasksByStatus()
  // Why: derives one state per retained dispatch row in TS (the same scan `worker-list` runs),
  // so it grows with dispatch history rather than with live work.
  const workerTerminals = db.countWorkerTerminalInventory()
  let terminals = 0
  let terminalsUnverifiable = 0
  let terminalsExited = 0
  let agents = 0
  const agentsByState: Record<RuntimeServeStatsAgentState, number> = {
    working: 0,
    permission: 0,
    idle: 0,
    unknown: 0
  }
  // Hoisted: the hook snapshot is one process-wide array, not a per-pty read.
  const hookRows = runtime.getAgentStatusSnapshotFn?.() ?? []
  for (const [ptyId, pty] of runtime.ptysById) {
    if (!pty.connected) {
      // Registered, but not connected. Only a host-delivered exit frame reaches the liveness
      // register, so an `exited` verdict there is a death certificate; anything weaker is loss
      // of contact, which is never proof of death and must stay on the conservative side.
      if (runtime.getPtyLivenessVerdict(ptyId)?.status === 'exited') {
        terminalsExited++
      } else {
        terminalsUnverifiable++
      }
      continue
    }
    terminals++
    if (
      runtime.resolvePaneAgentIdentityField(
        pty.launchAgent,
        pty.foregroundAgent,
        getLatestPtyTitle(pty),
        pty.paneKey
      ).agentIdentity
    ) {
      agents++
      agentsByState[resolveServeStatsPtyAgentState(runtime, pty, hookRows)]++
    }
  }
  for (const session of getStructuredAgentSessionHost()?.listSessionTabs() ?? []) {
    if (observeStructuredWorker(session).status === 'live') {
      agents++
      // The session host proves liveness, never turn state: reporting anything else here would
      // be a guess (see RuntimeServeStatsResult.counts.agentsByState).
      agentsByState.unknown++
    }
  }
  // Pages of both kinds plus their renderer footprint, from one walk of the bridge's page-id
  // registration map.
  const browserPages = collectServeStatsBrowserPages(
    runtime as unknown as Parameters<typeof collectServeStatsBrowserPages>[0],
    runtime.agentBrowserBridge
  )
  return {
    version: getAppEnvironment().getVersion(),
    runtimeId: runtime.getRuntimeId(),
    uptimeSeconds: Math.floor((Date.now() - runtime.startedAt) / 1000),
    port: runtime.servePort,
    counts: {
      agents,
      tasks,
      terminals,
      terminalsUnverifiable,
      terminalsExited,
      worktrees: worktrees.totalCount,
      browserPages: browserPages.total,
      browserPagesRetained: browserPages.retained,
      // Bytes, not a count, but scoped to exactly the population `browserPages` counts — and
      // null, never 0, wherever no renderer footprint was measurable (see
      // RuntimeServeStatsResult.counts.browserPageMemoryTotalBytes).
      browserPageMemoryTotalBytes: browserPages.memory.totalBytes,
      browserPageMemoryMaxBytes: browserPages.memory.maxBytes,
      tasksByStatus,
      agentsByState,
      workersByTerminalState: Object.fromEntries(
        WORKER_TERMINAL_LIST_STATES.map((state) => [state, workerTerminals.counts[state] ?? 0])
      ) as Record<WorkerTerminalListState, number>
    },
    // Host-wide, never Orca-attributed, and null wherever this platform cannot measure
    // (see RuntimeServeStatsResult.host).
    host: collectServeStatsHost(),
    health: {
      eventLoopDelayP99Ms: readServeStatsEventLoopDelayP99Ms(),
      // Null whenever no RPC server registered its counters: the caps are the server's, and an
      // invented 0/0 would read as a runtime that can admit nothing (see
      // RuntimeServeStatsHealth.longPolls).
      longPolls: runtime.longPollStatsProvider?.() ?? null
    }
  }
}
