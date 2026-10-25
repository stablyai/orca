import { OrcaRuntimeWithStateFields } from '../construction/runtime-construction'
import {
  persistClientHostedBrowserPages,
  rehydrateClientHostedBrowserPages
} from '../client-hosted-browser-page-persistence'
import { getRuntimeBrowserPageRegistry } from '../runtime-browser-page-registry'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { LOCAL_EXECUTION_HOST_ID, getRepoExecutionHostId } from '../../../shared/execution-host'
import type { IPtyProvider } from '../../providers/pty-provider-contract'
import { killAllProcessesForWorktree } from '../worktree-teardown'
import type { MemorySnapshot, StatsSummary } from '../../../shared/process-stats-types'
import { collectMemorySnapshot } from '../../memory/collector'
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import type { FeatureInteractionId } from '../../../shared/feature-interactions'
import type { RuntimeClientSettingsUpdate } from '../runtime-client-settings-shape'
import type { AgentLaunchSettingsMutation } from '../../../shared/agent-launch-settings'
import type { TerminalQuickCommand } from '../../../shared/terminal-quick-command-types'
import type { TerminalQuickCommandMutation } from '../../../shared/terminal-quick-commands'
import type { NativeChatSessionOptionSettingsMutation } from '../../../shared/native-chat-session-options'
import type { WorktreeTerminalStopOptions } from '../terminal/stop/worktree-terminal-stop-options'
import type { PtyLivenessVerdict } from '../../../shared/pty-liveness-verdict'
import type { Automation } from '../../../shared/automations-types'

export abstract class OrcaRuntimeWithPtyForegroundProcessReads extends OrcaRuntimeWithStateFields {
  abstract retireStructuredAgentSessionTabFromSnapshot(sessionId: string): boolean

  abstract getPtyLivenessVerdict(ptyId: string): PtyLivenessVerdict | null

  abstract forgetStructuredSessionMail(sessionId: string): void

  abstract stopTerminalsForWorktree(
    worktreeSelector: string,
    options?: WorktreeTerminalStopOptions
  ): Promise<{ stopped: number }>

  protected abstract setWorkspaceSessionForWorktree(
    worktreeId: string,
    session: WorkspaceSessionState
  ): void

  protected abstract getWorkspaceSessionForWorktree(
    worktreeId: string
  ): WorkspaceSessionState | null

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

  /** Rehydrate before attach; fleet restarts can kill client guests too, leaving only persisted page records.
   * Startup owns ordering and I/O so runtime construction stays free of persistence reads. */
  rehydrateClientHostedBrowserPages(): void {
    if (!this.store?.getWorkspaceSession) {
      return
    }
    try {
      const registry = getRuntimeBrowserPageRegistry(this)
      const liveRepoIds = new Set((this.store.getRepos?.() ?? []).map((repo) => repo.id))
      rehydrateClientHostedBrowserPages(registry, {
        listWorkspaceSessions: () => this.listWorkspaceSessionPartitions(),
        // Match hydration's repo discriminant: stale sessions for removed repos must not resurrect tabs.
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

  /** Skip session reads for workspaces without client pages on this hot terminal/editor-change seam. */
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
    // This process has no SSH PTY provider and cannot stop that host's terminals.
    const provider = connectionId ? null : this.getLocalProvider()
    if (!provider) {
      throw new Error(`PTY provider unavailable for worktree deletion: ${worktreeId}`)
    }
    const teardownResult = await killAllProcessesForWorktree(worktreeId, {
      runtime: this,
      // Host-fence path-derived ids so same-id workspaces on other connections survive.
      resolvedWorktreeId: worktreeId,
      localProvider: provider,
      onPtyStopped: this.onPtyStopped ?? undefined,
      requirePhysicalStop: true,
      // #11960: only explicit Force Delete bypasses unverified-stop refusal.
      ...(allowUnverifiedStop ? { allowUnverifiedStop: true } : {})
    })
    // Include structured chats in removal totals even when no PTY was stopped.
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

  getWorkspaceSessionForHost(hostId: ExecutionHostId): WorkspaceSessionState | null {
    return this.store?.getWorkspaceSession?.(hostId) ?? null
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

  getClientAgentLaunchSettings() {
    return this.clientSettings.getAgentLaunch()
  }

  mutateClientAgentLaunchSettings(mutation: AgentLaunchSettingsMutation) {
    return this.clientSettings.mutateAgentLaunch(mutation)
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
