import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree } from '../terminal/launch/terminal-workspace-scope'
import type { RuntimeWorktreeListResult } from '../../../shared/runtime-worktree-contracts'
import type { DetectedWorktreeListResult, Worktree } from '../../../shared/worktree/types'
import type { Repo } from '../../../shared/repo-types'
import type { RepoRowExecutionHostLookup } from '../../../shared/execution-host/worktree-execution-host-resolution'
import { stopMissingWorktreeTerminals } from './removal/missing-worktree-terminal-reconciliation'
import type { WorktreeVisibilitySourceMatcher } from '../../../shared/worktree/visibility-sources'
import type { RuntimeStore } from '../construction/runtime-store-contract'
import { getWorkspaceAttachments } from '../../../shared/workspace-attachments/workspace-attachments'
import type { TerminalWorkspaceLaunchScope } from '../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { RuntimeWorkspacePortOperations } from './ports/runtime-workspace-port-operations'
const DEFAULT_WORKTREE_LIST_LIMIT = 200
export abstract class OrcaRuntimeWithListManagedWorktrees extends RuntimeWorkspacePortOperations {
  protected abstract resolveFolderWorkspaceSelector(
    selector: string,
    requiredHostId?: ExecutionHostId
  ): FolderWorkspace | null

  protected abstract resolveTerminalWorkspaceLaunchTarget(
    ...args: Parameters<
      OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree['resolveTerminalWorkspaceLaunchTarget']
    >
  ): ReturnType<
    OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree['resolveTerminalWorkspaceLaunchTarget']
  >

  listManagedWorktrees(
    repoSelector?: string,
    limit = DEFAULT_WORKTREE_LIST_LIMIT,
    sourceDefaultsSupported = true
  ): Promise<RuntimeWorktreeListResult> {
    return this.managedWorktreeQueries.list(repoSelector, limit, sourceDefaultsSupported)
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
    // Stop PTYs against fresh host evidence: cached scans can miss removed Git registrations and strand processes after renderer purge.
    this.invalidateWorktreeScanCacheForRepo(repo.id)
    // Reuse the resolved repo; duplicate ids across hosts could make a second id lookup ambiguous and lose the sweep.
    const detected = await this.listDetectedWorktreesForResolvedRepo(repo)
    if (!detected.authoritative) {
      return { stoppedWorktreeIds: [] }
    }
    return stopMissingWorktreeTerminals(
      repo,
      knownWorktreeIds,
      detected.worktrees.map((worktree) => worktree.id),
      {
        runtime: this,
        getLocalProvider: () => this.getLocalProvider(),
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
    providedSettings?: ReturnType<RuntimeStore['getSettings']>,
    repoLookup?: RepoRowExecutionHostLookup<Repo>
  ): boolean {
    return this.managedWorktreeQueries.isVisible(
      worktree,
      worktreeVisibilitySourceMatcher,
      sourceDefaultsSupported,
      providedSettings,
      repoLookup
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

  async showManagedWorktree(
    worktreeSelector: string,
    requiredHostId?: ExecutionHostId,
    options: { matchFolders?: boolean } = {}
  ) {
    const worktree = await this.resolveWorkspaceSelector(worktreeSelector, {
      requiredHostId,
      matchFolders: options.matchFolders
    })
    const childKey = worktreeWorkspaceKey(worktree.id)
    const crossStoreLineage = this.store?.getCrossStoreWorkspaceLineage?.(childKey)
    const workspaceLineage = this.store?.getWorkspaceLineage?.(childKey)
    return {
      ...worktree,
      linkedItems: getWorkspaceAttachments(worktree),
      // This row's same-store parent record (a folder parent has no worktree lineage); a same-path
      // twin's record reads as none.
      workspaceLineage:
        workspaceLineage &&
        (!workspaceLineage.childInstanceId ||
          workspaceLineage.childInstanceId === worktree.instanceId)
          ? workspaceLineage
          : null,
      // A parent on another machine; the same-store lineage fields stay null for it.
      ...(crossStoreLineage && crossStoreLineage.childInstanceId === worktree.instanceId
        ? { crossStoreLineage }
        : {})
    }
  }

  /**
   * The git worktree record behind a terminal workspace. Refuses the floating sentinel, which has
   * no such record — callers that only need to address the workspace want the scope below instead.
   */
  async showManagedTerminalWorkspace(worktreeSelector: string, requiredHostId?: ExecutionHostId) {
    const target = await this.resolveManagedTerminalWorkspaceTarget(
      worktreeSelector,
      requiredHostId
    )
    if (!target.managedWorktree) {
      throw new Error('selector_not_found')
    }
    return target.managedWorktree
  }

  async resolveManagedTerminalWorkspaceTarget(
    worktreeSelector: string,
    requiredHostId?: ExecutionHostId,
    checkPath = true
  ) {
    const key = worktreeSelector.startsWith('id:') ? worktreeSelector.slice(3) : worktreeSelector
    const scope = parseWorkspaceKey(key)
    const folder =
      scope?.type === 'folder'
        ? this.resolveFolderWorkspaceSelector(worktreeSelector, requiredHostId)
        : undefined
    const resolved =
      requiredHostId && scope?.type !== 'folder'
        ? await this.showManagedWorktree(worktreeSelector, requiredHostId)
        : undefined
    return this.resolveTerminalWorkspaceLaunchTarget(
      worktreeSelector,
      undefined,
      {},
      resolved,
      folder ?? undefined,
      checkPath
    )
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
}
