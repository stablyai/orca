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
import { collectMemorySnapshot } from '../memory/collector'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import type { FeatureInteractionId } from '../../shared/feature-interactions'
import type { RuntimeClientSettingsUpdate } from './runtime-client-settings'
import type { TerminalQuickCommand } from '../../shared/terminal-quick-command-types'
import type { TerminalQuickCommandMutation } from '../../shared/terminal-quick-commands'
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
    const total =
      teardownResult.runtimeStopped +
      teardownResult.providerStopped +
      teardownResult.registryStopped
    if (total > 0) {
      console.info(
        `[worktree-teardown] ${worktreeId} killed runtime=${teardownResult.runtimeStopped} provider=${teardownResult.providerStopped} registry=${teardownResult.registryStopped}`
      )
    }
  }

  getStatsSummary(): StatsSummary | null {
    return this.stats?.getSummary() ?? null
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

  listAutomations(): Automation[] {
    return this.automation.list()
  }
}
