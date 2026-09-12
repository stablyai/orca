/* eslint-disable max-lines -- Why: getServeStats and runtime state accessors are mechanically co-located in this split mixin. */
// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithStateFields } from './orca-runtime-state-fields'
import {
  persistClientHostedBrowserPages,
  rehydrateClientHostedBrowserPages
} from './client-hosted-browser-page-persistence'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { LOCAL_EXECUTION_HOST_ID, getRepoExecutionHostId } from '../../shared/execution-host'
import type { IPtyProvider } from '../providers/types'
import { killAllProcessesForWorktree } from './worktree-teardown'
import type { RuntimeCommandSurfaceHost } from './orca-runtime-core'
import type { MemorySnapshot, StatsSummary } from '../../shared/process-stats-types'
import type {
  RuntimeServeStatsAgentState,
  RuntimeServeStatsLongPolls,
  RuntimeServeStatsResult
} from '../../shared/runtime-types'
import {
  WORKER_TERMINAL_LIST_STATES,
  type WorkerTerminalListState
} from '../../shared/worker-terminal-list-state'
import type { AgentStatus } from '../../shared/agent-detection'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { getAppEnvironment } from '../../shared/app-environment'
import { deriveServeStatsAgentState, getLatestPtyTitle } from './runtime-worktree-status-projection'
import { selectFreshExplicitAgentStatus } from './runtime-hook-agent-row-selection'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { observeStructuredWorker } from './structured-worker-authority'
import { collectMemorySnapshot } from '../memory/collector'
import { collectServeStatsHost } from './serve-stats-host'
import { readServeStatsEventLoopDelayP99Ms } from './serve-stats-event-loop-delay'
import { collectServeStatsBrowserPages } from './serve-stats-browser-pages'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import type { FeatureInteractionId } from '../../shared/feature-interactions'
import type { RuntimeClientSettingsUpdate } from './runtime-client-settings'
import type { TerminalQuickCommand } from '../../shared/terminal-quick-command-types'
import type { TerminalQuickCommandMutation } from '../../shared/terminal-quick-commands'
import type { NativeChatSessionOptionSettingsMutation } from '../../shared/native-chat-session-options'
import type { Automation } from '../../shared/automations-types'

export class OrcaRuntimeWithPtyForegroundProcessReads extends OrcaRuntimeWithStateFields {
  get ptyForegroundProcessReads() {
    return this.ptyForegroundAgent.getReads()
  }

  refreshPtyForegroundAgentFromController(
    ptyId: string,
    options: { afterTitleObservation?: number } = {}
  ): Promise<boolean> {
    return this.ptyForegroundAgent.refresh(ptyId, options.afterTitleObservation ?? 0)
  }

  // Compatibility seam for diagnostics/tests that inspect waiter ownership.
  get messageWaitersByHandle() {
    return this.messageWaiters.map
  }

  // Why: retained as read-only compatibility seams for cache-boundary tests.
  protected get canonicalFetchKeyCache(): ReadonlyMap<string, string> {
    return this.remoteFetches.getCanonicalFetchKeyCache()
  }

  protected get fetchLastCompletedAt(): ReadonlyMap<string, number> {
    return this.remoteFetches.getFetchLastCompletedAt()
  }

  /**
   * Republishes persisted client-hosted pages as held rows, before any host can attach.
   *
   * Without this a runtime restart takes the only record of a client-hosted page with it. When the
   * client restarted too -- a fleet update restarts both -- its guests died with it, so its
   * inventory has nothing to adopt from and no participant can name the page any more.
   *
   * Called from each host's startup rather than the constructor so the ordering against attach is
   * explicit, and so constructing a runtime stays free of persistence reads.
   */
  rehydrateClientHostedBrowserPages(): void {
    if (!this.store?.getWorkspaceSession) {
      return
    }
    try {
      const registry = getRuntimeBrowserPageRegistry(this)
      const liveRepoIds = new Set((this.store.getRepos?.() ?? []).map((repo) => repo.id))
      rehydrateClientHostedBrowserPages(registry, {
        listWorkspaceSessions: () => this.listWorkspaceSessionPartitions(),
        // Why the same discriminant hydration uses: session keys are `${repoId}::${path}` and are
        // not pruned when a repo leaves this client's view, so a row whose repo is gone would
        // surface a tab with no live workspace behind it. Unparseable keys are left alone.
        isKnownWorktree: (worktreeId) => {
          const ownerRepoId = splitWorktreeIdForFilesystem(worktreeId)?.repoId
          return !ownerRepoId || liveRepoIds.has(ownerRepoId)
        }
      })
      for (const page of registry.listPages()) {
        this.persistedClientHostedBrowserWorktreeIds.add(page.workspaceId)
      }
    } catch (error) {
      console.warn('[browser-host-lease] client page rehydration failed:', error)
    }
  }

  /**
   * Rewrites one worktree's persisted client-hosted rows.
   *
   * Guarded because it hangs off the runtime's tab-change announcement, which also fires on
   * terminal and editor churn: a workspace that has never had a client page must not pay a session
   * read for every one of those.
   */
  protected persistClientHostedBrowserPagesForWorktree(worktreeId: string): void {
    const registry = getRuntimeBrowserPageRegistry(this)
    const hasPages = registry.listPages(worktreeId).length > 0
    if (!hasPages && !this.persistedClientHostedBrowserWorktreeIds.has(worktreeId)) {
      return
    }
    if (hasPages) {
      this.persistedClientHostedBrowserWorktreeIds.add(worktreeId)
    } else {
      this.persistedClientHostedBrowserWorktreeIds.delete(worktreeId)
    }
    persistClientHostedBrowserPages(
      {
        getWorkspaceSession: (id) => this.getWorkspaceSessionForWorktree(id),
        setWorkspaceSession: (id, session) => this.setWorkspaceSessionForWorktree(id, session)
      },
      registry,
      worktreeId
    )
  }

  protected listWorkspaceSessionPartitions(): WorkspaceSessionState[] {
    const hostIds = new Set<ExecutionHostId>([LOCAL_EXECUTION_HOST_ID])
    for (const repo of this.store?.getRepos?.() ?? []) {
      hostIds.add(getRepoExecutionHostId(repo))
    }
    return [...hostIds].flatMap((hostId) => {
      const session = this.store?.getWorkspaceSession?.(hostId)
      return session ? [session] : []
    })
  }

  getLocalProvider(): IPtyProvider | null {
    return this.getLocalProviderFn ? this.getLocalProviderFn() : null
  }

  protected async stopPtysForDestructiveWorktreeRemoval(
    worktreeId: string,
    options: { connectionId?: string; allowUnverifiedStop?: boolean } = {}
  ): Promise<void> {
    const { connectionId, allowUnverifiedStop } = options
    const provider = connectionId ? this.getSshProviderFn?.(connectionId) : this.getLocalProvider()
    if (!provider) {
      throw new Error(`PTY provider unavailable for worktree deletion: ${worktreeId}`)
    }
    const teardownResult = await killAllProcessesForWorktree(worktreeId, {
      runtime: this as RuntimeCommandSurfaceHost<this>,
      // Why: `repoId::path` ids repeat across hosts, so an unfenced sweep stops a same-id
      // workspace's terminals on another connection (mirrors the IPC removal path).
      resolvedWorktreeId: worktreeId,
      ...(connectionId ? { resolvedConnectionId: connectionId } : {}),
      localProvider: provider,
      onPtyStopped: this.onPtyStopped ?? undefined,
      requirePhysicalStop: true,
      // Why (#11960): set only by an explicit Force Delete, never by the ordinary
      // confirmation — otherwise the gate would be off on the primary delete path.
      ...(allowUnverifiedStop ? { allowUnverifiedStop: true } : {}),
      ...(connectionId ? { includeLocalRegistry: false } : {})
    })
    // Structured sessions are counted here too, mirroring the IPC path: closing a user's chat is
    // now an ordinary outcome of this verb, and a removal that closed one but no PTY logged nothing.
    const structuredStopped = teardownResult.structuredStopped ?? 0
    const total =
      teardownResult.runtimeStopped +
      teardownResult.providerStopped +
      teardownResult.registryStopped +
      structuredStopped
    if (total > 0) {
      console.info(
        `[worktree-teardown] ${worktreeId} killed runtime=${teardownResult.runtimeStopped} provider=${teardownResult.providerStopped} registry=${teardownResult.registryStopped} structured=${structuredStopped}`
      )
    }
  }

  getStatsSummary(): StatsSummary | null {
    return this.stats?.getSummary() ?? null
  }

  setServePort(port: number | null): void {
    this.servePort = port
  }

  /**
   * Registers the RPC server's live long-poll reader, or clears it with `null` on shutdown.
   *
   * A pull, not a push: the counters move on every long-poll admit and release (the hot path for
   * every `terminal.wait` / `orchestration.ask` in the fleet), so a setter called per increment
   * would put a cross-object write on that path and go stale the moment any release path forgot
   * to call it. One closure registered where `setServePort` is, read only when someone actually
   * asks for stats, cannot drift from the counters it reads. Null means "no listener is serving",
   * which is exactly when there is no admission budget to report.
   */
  setLongPollStatsProvider(provider: (() => RuntimeServeStatsLongPolls) | null): void {
    this.longPollStatsProvider = provider
  }

  // Occupancy follows runtime PTYs; turn-duration statistics exclude waiting agents.
  async getServeStats(): Promise<RuntimeServeStatsResult> {
    const worktrees = await this.listManagedWorktrees()
    const db = this.getOrchestrationDb()
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
    const hookRows = this.getAgentStatusSnapshotFn?.() ?? []
    for (const [ptyId, pty] of this.ptysById) {
      if (!pty.connected) {
        // Registered, but not connected. Only a host-delivered exit frame reaches the liveness
        // register, so an `exited` verdict there is a death certificate; anything weaker is loss
        // of contact, which is never proof of death and must stay on the conservative side.
        if (this.getPtyLivenessVerdict(ptyId)?.status === 'exited') {
          terminalsExited++
        } else {
          terminalsUnverifiable++
        }
        continue
      }
      terminals++
      if (
        this.resolvePaneAgentIdentityField(
          pty.launchAgent,
          pty.foregroundAgent,
          getLatestPtyTitle(pty),
          pty.paneKey
        ).agentIdentity
      ) {
        agents++
        agentsByState[this.resolveServeStatsPtyAgentState(pty, hookRows)]++
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
    const browserPages = collectServeStatsBrowserPages(this, this.agentBrowserBridge)
    return {
      version: getAppEnvironment().getVersion(),
      runtimeId: this.getRuntimeId(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      port: this.servePort,
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
        longPolls: this.longPollStatsProvider?.() ?? null
      }
    }
  }

  /**
   * One connected pty's turn state, from maps this process already holds.
   *
   * The explicit hook status is keyed by pane, and the lifecycle tracker by pty id, so neither
   * needs a terminal handle, a syscall, or a DB read; a pty with no current evidence stays
   * `unknown` rather than borrowing a plausible state.
   */
  protected resolveServeStatsPtyAgentState(
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
          handle: this.handleByPtyId.get(pty.ptyId) ?? null,
          paneKey: pty.paneKey,
          hookRows
        })
      : null
    const floor = this.agentPromptExplicitStatusFloorByPtyId.get(pty.ptyId)
    return deriveServeStatsAgentState({
      // Why: a status recorded before the last prompt submission is superseded evidence.
      explicit: explicit && (floor === undefined || explicit.updatedAt > floor) ? explicit : null,
      lifecycle: this.agentPromptLifecycleByPtyId.get(pty.ptyId),
      titleStatus: pty.lastAgentStatus,
      titleStatusObservedLive: pty.lastAgentStatusObservedLive
    })
  }

  getMemorySnapshot(): Promise<MemorySnapshot> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return collectMemorySnapshot(this.store)
  }

  getUIState(): PersistedUIState {
    if (!this.store?.getUI) {
      throw new Error('runtime_unavailable')
    }
    return this.store.getUI()
  }

  updateUIState(updates: Partial<PersistedUIState>): PersistedUIState {
    if (!this.store?.getUI || !this.store.updateUI) {
      throw new Error('runtime_unavailable')
    }
    this.store.updateUI(updates)
    return this.store.getUI()
  }

  recordFeatureInteraction(id: FeatureInteractionId): PersistedUIState {
    if (!this.store?.recordFeatureInteraction) {
      throw new Error('runtime_unavailable')
    }
    return this.store.recordFeatureInteraction(id)
  }

  getClientSettings() {
    return this.clientSettings.get()
  }

  async updateClientSettings(updates: RuntimeClientSettingsUpdate) {
    return await this.clientSettings.update(updates)
  }

  getClientTerminalQuickCommands(): TerminalQuickCommand[] {
    return this.clientSettings.getTerminalQuickCommands()
  }

  updateClientTerminalQuickCommands(
    mutation: TerminalQuickCommandMutation
  ): TerminalQuickCommand[] {
    return this.clientSettings.updateTerminalQuickCommands(mutation)
  }

  updateClientPRBotAuthorOverride(args: { author: string; isBot: boolean }) {
    return this.clientSettings.updatePRBotAuthorOverride(args)
  }

  updateClientNativeChatSessionOptions(mutation: NativeChatSessionOptionSettingsMutation): void {
    this.clientSettings.updateNativeChatSessionOptions(mutation)
  }

  listAutomations(): Automation[] {
    return this.automation.list()
  }
}
