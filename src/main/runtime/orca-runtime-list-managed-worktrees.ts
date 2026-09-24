// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce } from './orca-runtime-restore-structured-agent-session-tabs-once'
import { DEFAULT_WORKTREE_LIST_LIMIT } from './orca-runtime-postlude'
import type { RuntimeWorktreeListResult } from '../../shared/runtime-types'
import type { DetectedWorktreeListResult, Worktree } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import { stopMissingWorktreeTerminals } from './missing-worktree-terminal-reconciliation'
import type { RuntimeCommandSurfaceHost } from './orca-runtime-core'
import type { WorktreeVisibilitySourceMatcher } from '../../shared/worktree/visibility-sources'
import type { RuntimeStore } from './runtime-store-contract'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type {
  WorkspacePortKillRequest,
  WorkspacePortKillResult,
  WorkspacePortProbe,
  WorkspacePortScanResult
} from '../../shared/workspace-ports'
import {
  filterWorkspacePortProbes,
  killWorkspacePort,
  scanWorkspacePortProbes
} from '../ports/workspace-port-ownership'
import { settleListedWorkspaceStatuses } from '../worktree/settle-listed-workspace-status'

export class OrcaRuntimeWithListManagedWorktrees extends OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce {
  async listManagedWorktrees(
    repoSelector?: string,
    limit = DEFAULT_WORKTREE_LIST_LIMIT,
    sourceDefaultsSupported = true
  ): Promise<RuntimeWorktreeListResult> {
    const page = await this.managedWorktreeQueries.list(
      repoSelector,
      limit,
      sourceDefaultsSupported
    )
    if (!this.store) {
      return page
    }
    try {
      const worktrees = await settleListedWorkspaceStatuses({
        store: this.store,
        worktrees: page.worktrees,
        orchestrationDb: this.peekOrchestrationDb?.() ?? null
      })
      return { ...page, worktrees }
    } catch {
      return page
    }
  }

  listRetiredWorktreeNames(repoSelector: string) {
    return this.managedWorktreeQueries.listRetiredNames(repoSelector)
  }

  async listDetectedManagedWorktrees(
    repoSelector: string,
    connectionId?: string | null,
    sourceDefaultsSupported = true
  ): Promise<DetectedWorktreeListResult> {
    return this.listDetectedWorktreesForResolvedRepo(
      await this.resolveRepoSelectorForConnection(repoSelector, connectionId),
      sourceDefaultsSupported
    )
  }

  protected listDetectedWorktreesForResolvedRepo(
    repo: Repo,
    sourceDefaultsSupported = true
  ): Promise<DetectedWorktreeListResult> {
    return this.managedWorktreeQueries.listDetected(repo, sourceDefaultsSupported)
  }

  async teardownMissingManagedWorktreeTerminals(
    repoSelector: string,
    knownWorktreeIds: readonly string[],
    connectionId?: string | null
  ): Promise<{ stoppedWorktreeIds: string[] }> {
    const repo = await this.resolveRepoSelectorForConnection(repoSelector, connectionId)
    // Why: killing PTYs must be proven against the host right now — a cached scan
    // (30s TTL) can still list a directory git already dropped, and the renderer
    // purges its state either way, so a stale miss strands those processes for good.
    this.invalidateWorktreeScanCacheForRepo(repo.id)
    // Why: rescanning by `id:` would re-resolve the already-resolved repo, and a
    // duplicate id across hosts makes that second lookup throw selector_ambiguous
    // even though the caller's selector was unique — losing the sweep entirely.
    const detected = await this.listDetectedWorktreesForResolvedRepo(repo)
    if (!detected.authoritative) {
      return { stoppedWorktreeIds: [] }
    }
    return stopMissingWorktreeTerminals(
      repo,
      knownWorktreeIds,
      detected.worktrees.map((worktree) => worktree.id),
      {
        runtime: this as RuntimeCommandSurfaceHost<this>,
        getLocalProvider: () => this.getLocalProvider(),
        getSshProvider: (connectionId) => this.getSshProviderFn?.(connectionId),
        onPtyStopped: this.onPtyStopped ?? undefined
      }
    )
  }

  protected resolveRepoSelectorForConnection(
    repoSelector: string,
    connectionId?: string | null
  ): Promise<Repo> {
    return this.managedWorktreeQueries.resolveRepoForConnection(repoSelector, connectionId)
  }

  protected isRuntimeWorktreeVisible(
    worktree: Worktree,
    worktreeVisibilitySourceMatcher?: WorktreeVisibilitySourceMatcher,
    sourceDefaultsSupported = true,
    providedSettings?: ReturnType<RuntimeStore['getSettings']>
  ): boolean {
    return this.managedWorktreeQueries.isVisible(
      worktree,
      worktreeVisibilitySourceMatcher,
      sourceDefaultsSupported,
      providedSettings
    )
  }

  protected buildRuntimeVisibilitySourceMatchersByRepoId(
    worktrees: readonly Worktree[],
    sourceDefaultsSupported = true,
    providedSettings?: ReturnType<RuntimeStore['getSettings']>
  ): Map<string, WorktreeVisibilitySourceMatcher> {
    return this.managedWorktreeQueries.buildVisibilityMatchers(
      worktrees,
      sourceDefaultsSupported,
      providedSettings
    )
  }

  async showManagedWorktree(worktreeSelector: string) {
    return await this.resolveWorktreeSelector(worktreeSelector)
  }

  /**
   * The git worktree record behind a terminal workspace. Refuses the floating sentinel, which has
   * no such record — callers that only need to address the workspace want the scope below instead.
   */
  async showManagedTerminalWorkspace(worktreeSelector: string) {
    const target = await this.resolveTerminalWorkspaceLaunchTarget(worktreeSelector)
    if (!target.managedWorktree) {
      throw new Error('selector_not_found')
    }
    return target.managedWorktree
  }

  /**
   * Where a terminal workspace is, for every kind one can be: a git worktree, a folder workspace,
   * or the floating sentinel. This is the general answer — `id` and `path` are resolved the same
   * way for all three — so a caller that reads only those must ask for this rather than demand a
   * worktree record it never reads and lose the floating workspace to a `selector_not_found`.
   */
  async showTerminalWorkspaceLaunchScope(
    worktreeSelector: string
  ): Promise<TerminalWorkspaceLaunchScope> {
    return await this.resolveTerminalWorkspaceLaunchScope(worktreeSelector)
  }

  async scanWorkspacePorts(repoId?: string): Promise<WorkspacePortScanResult> {
    return scanWorkspacePortProbes(await this.getWorkspacePortProbes(repoId))
  }

  async killWorkspacePort(args: WorkspacePortKillRequest): Promise<WorkspacePortKillResult> {
    return killWorkspacePort(await this.getWorkspacePortProbes(args.repoId), args)
  }

  // Why: remote clients may invoke this over RPC, so the runtime derives
  // allowed worktree paths from its own store instead of trusting client paths.
  protected async getWorkspacePortProbes(repoId?: string): Promise<WorkspacePortProbe[]> {
    const reposById = new Map(
      this.requireStore()
        .getRepos()
        .map((repo) => [repo.id, repo])
    )
    return filterWorkspacePortProbes(
      (await this.listResolvedWorktrees()).map((worktree) => ({
        id: worktree.id,
        repoId: worktree.repoId,
        displayName: worktree.displayName,
        path: worktree.git.path,
        connectionId: reposById.get(worktree.repoId)?.connectionId ?? null
      })),
      repoId
    )
  }

  async sleepManagedWorktree(worktreeSelector: string): Promise<{ worktreeId: string }> {
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    // Why: sleep is renderer-initiated on desktop (it tears down tab state
    // before killing PTYs). The notifier tells the renderer to run its own
    // sleep flow so all cleanup happens in the correct order.
    this.notifier?.sleepWorktree(worktree.id)
    return { worktreeId: worktree.id }
  }
}
