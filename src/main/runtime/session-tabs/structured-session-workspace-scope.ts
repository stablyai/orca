import { OrcaRuntimeWithStructuredSessionAccountHome } from './structured-session-account-home'
import {
  isNativeLocalLocation,
  LOCAL_EXECUTION_HOST_ID,
  getConnectionExecutionHostId,
  getRepoExecutionHostId,
  getRepoRoutingConnectionId
} from '../../../shared/execution-host'
import { getLocalProjectWorktreeGitOptions } from '../../project-runtime-git-options'
import {
  isFloatingWorkspaceId,
  isFloatingWorkspaceSelector
} from '../../../shared/floating-workspace-worktree'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import { resolveWorktreeHostRouting } from '../worktree-launch-host-repo'
import { getRepoHostIdentityForParts } from '../../../shared/repo-host-identity'
import type { OrcaRuntimeWithPersistHeadlessTerminalTitle } from '../workspaces/workspace-file-session-targets'
import type { OrcaRuntimeWithTransitionGraphReloadToTerminalState } from '../session-graph/session-graph-authority'
import type { RuntimeWorkspaceCatalog } from '../workspaces/workspace-catalog'
import type { RuntimeWorkspaceSelectors } from '../workspaces/workspace-selectors'

export abstract class StructuredSessionWorkspaceScope extends OrcaRuntimeWithStructuredSessionAccountHome {
  protected abstract resolveFolderWorkspaceSelector(
    ...args: Parameters<
      OrcaRuntimeWithTransitionGraphReloadToTerminalState['resolveFolderWorkspaceSelector']
    >
  ): ReturnType<
    OrcaRuntimeWithTransitionGraphReloadToTerminalState['resolveFolderWorkspaceSelector']
  >

  protected abstract projectCachedWorktrees(
    ...args: Parameters<RuntimeWorkspaceCatalog['projectCachedWorktrees']>
  ): ReturnType<RuntimeWorkspaceCatalog['projectCachedWorktrees']>

  protected abstract matchWorktreeSelector(
    ...args: Parameters<RuntimeWorkspaceSelectors['matchWorktreeSelector']>
  ): ReturnType<RuntimeWorkspaceSelectors['matchWorktreeSelector']>

  protected async resolveStructuredAgentSessionLocation(worktreeSelector: string) {
    const target = await this.resolveRuntimeFileTarget(worktreeSelector)
    return this.structuredAgentSessionLocationForTarget(target)
  }

  protected structuredAgentSessionLocationForTarget(
    target: Awaited<
      ReturnType<OrcaRuntimeWithPersistHeadlessTerminalTitle['resolveRuntimeFileTarget']>
    >
  ) {
    const routing = resolveWorktreeHostRouting(this.store?.getRepos() ?? [], target.worktree)
    if (routing.kind === 'ambiguous') {
      throw new Error('worktree_execution_host_unresolved')
    }
    const repo = routing.kind === 'resolved' ? routing.repo : null
    const folderScope = parseWorkspaceKey(target.worktree.id)
    // The floating workspace is a plain directory with no repo git options, which is exactly what
    // `folder` denotes here — it describes how Orca manages the place, not whether git is in it.
    const folderWorkspace =
      folderScope?.type === 'folder' || isFloatingWorkspaceId(target.worktree.id)
    // WSL routing describes *this* machine; no remote or runtime host may inherit
    // it. Both branches key on executionHostId: the target no longer carries a
    // connectionId, which used to spell remote, unresolved and local alike.
    const isLocalHost = target.executionHostId === LOCAL_EXECUTION_HOST_ID
    const configuredWslDistro =
      repo && isLocalHost
        ? (getLocalProjectWorktreeGitOptions(this.requireStore(), repo).wslDistro ?? null)
        : null
    // Folder workspaces have no repo Git options, so a WSL UNC path is the only
    // durable signal that native Windows structured Codex cannot safely use it.
    const wslDistro =
      configuredWslDistro ??
      (folderWorkspace && isLocalHost
        ? (parseWslUncPath(target.worktree.path)?.distro ?? null)
        : null)
    return {
      executionHostId: target.executionHostId,
      wslDistro,
      workspaceId: target.worktree.id,
      workspaceKind: folderWorkspace ? ('folder' as const) : ('git-worktree' as const)
    }
  }

  private projectStructuredAgentCatalogTarget(selector: string) {
    const folder = this.resolveFolderWorkspaceSelector(selector)
    if (folder) {
      return {
        worktree: this.folderWorkspaceToResolvedWorktree(folder),
        executionHostId: getConnectionExecutionHostId(
          this.resolveFolderWorkspaceConnectionId(folder)
        )
      }
    }
    const snapshot = this.projectCachedWorktrees()
    const explicitId = this.getValidatedExplicitWorktreeIdSelector(selector)
    const repoId = explicitId ? splitWorktreeIdForFilesystem(explicitId)?.repoId : undefined
    for (const repo of this.store?.getRepos() ?? []) {
      if (repoId && repo.id !== repoId) {
        continue
      }
      if (
        snapshot.unscannedRepoKeys.has(
          getRepoHostIdentityForParts(repo.id, getRepoExecutionHostId(repo))
        ) &&
        !(explicitId && getRepoRoutingConnectionId(repo) && this.store?.getWorktreeMeta(explicitId))
      ) {
        return null
      }
    }
    return this.runtimeFileTargetForWorktree(
      this.matchWorktreeSelector(selector, snapshot.worktrees)
    )
  }

  structuredAgentSessionCatalogWorkspaceIdentity(selector: string): string | null {
    if (isFloatingWorkspaceSelector(selector)) {
      const settings = this.store?.getSettings()
      return JSON.stringify([
        'floating',
        settings?.floatingTerminalCwd,
        settings?.floatingTerminalTrustedCwds
      ])
    }
    try {
      const target = this.projectStructuredAgentCatalogTarget(selector)
      return target
        ? JSON.stringify([
            target.worktree.path,
            this.structuredAgentSessionLocationForTarget(target)
          ])
        : null
    } catch (error) {
      return JSON.stringify(['unresolved', error instanceof Error ? error.message : 'unknown'])
    }
  }

  async resolveStructuredAgentCatalogWorkspace(selector: string) {
    const target = await this.resolveRuntimeFileTarget(selector)
    const location = this.structuredAgentSessionLocationForTarget(target)
    const identity = this.structuredAgentSessionCatalogWorkspaceIdentity(selector)
    if (
      !isFloatingWorkspaceSelector(selector) &&
      identity !== JSON.stringify([target.worktree.path, location])
    ) {
      throw new Error('workspace_scope_changed')
    }
    return { identity, path: isNativeLocalLocation(location) ? target.worktree.path : null }
  }

  /** Where a structured chat here would run, from the same target as its location. */
  async resolveStructuredAgentSessionLocalWorkspacePath(worktreeSelector: string) {
    const target = await this.resolveRuntimeFileTarget(worktreeSelector)
    return isNativeLocalLocation(this.structuredAgentSessionLocationForTarget(target))
      ? target.worktree.path
      : null
  }
}
