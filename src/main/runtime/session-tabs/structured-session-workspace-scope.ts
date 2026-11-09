import { prepareStructuredWorkspaceAuthority } from './structured-workspace-authority'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { OrcaRuntimeWithStructuredSessionAccountHome } from './structured-session-account-home'
import {
  isNativeLocalLocation,
  LOCAL_EXECUTION_HOST_ID,
  getConnectionExecutionHostId,
  getRepoExecutionHostId
} from '../../../shared/execution-host'
import { getLocalProjectWorktreeGitOptions } from '../../workspaces/execution-host/project-runtime-git-options'
import {
  isFloatingWorkspaceId,
  isFloatingWorkspaceSelector
} from '../../../shared/floating-workspace-worktree'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { composeWorktreeId, splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import { resolveWorktreeHostRouting } from '../workspaces/catalog/worktree-launch-host-repo'
import type { RuntimeWorkspaceFileTargets } from '../workspaces/workspace-file-session-targets'
import type { OrcaRuntimeWithTransitionGraphReloadToTerminalState } from '../session-graph/session-graph-authority'
import type { RuntimeWorkspaceCatalog } from '../workspaces/catalog/workspace-catalog'
import type { RuntimeWorkspaceSelectors } from '../workspaces/workspace-selectors'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { NotificationAttentionAcknowledgement } from '../../../shared/notification-settings-types'

export abstract class StructuredSessionWorkspaceScope extends OrcaRuntimeWithStructuredSessionAccountHome {
  protected abstract resolveFolderWorkspaceSelector(
    ...args: Parameters<
      OrcaRuntimeWithTransitionGraphReloadToTerminalState['resolveFolderWorkspaceSelector']
    >
  ): ReturnType<
    OrcaRuntimeWithTransitionGraphReloadToTerminalState['resolveFolderWorkspaceSelector']
  >

  protected abstract buildResolvedWorktreeFromId(
    ...args: Parameters<RuntimeWorkspaceSelectors['buildResolvedWorktreeFromId']>
  ): ReturnType<RuntimeWorkspaceSelectors['buildResolvedWorktreeFromId']>

  protected abstract selectReposBySelector(
    ...args: Parameters<RuntimeWorkspaceSelectors['selectReposBySelector']>
  ): ReturnType<RuntimeWorkspaceSelectors['selectReposBySelector']>

  protected abstract listRepoWorktreesForResolution(
    ...args: Parameters<RuntimeWorkspaceCatalog['listRepoWorktreesForResolution']>
  ): ReturnType<RuntimeWorkspaceCatalog['listRepoWorktreesForResolution']>

  prepareStructuredAgentSessionRevealWorkspace(location: AgentSessionExecutionLocation) {
    return prepareStructuredWorkspaceAuthority(this.requireStore(), location, (repo) =>
      this.listRepoWorktreesForResolution(repo)
    )
  }

  async prepareWorkspaceAttentionAcknowledgement(
    worktreeSelector: string
  ): Promise<NotificationAttentionAcknowledgement> {
    const worktree = await this.resolveStructuredAgentSessionLocation(worktreeSelector)
    const host = getStructuredAgentSessionHost()
    const reads = host
      ? await host.attentionReads.workspace(worktree)
      : (await this.openAgentSessionRecordStore()).workspaceAttentionReads(worktree)
    return { worktree, reads }
  }

  protected async resolveStructuredAgentSessionLocation(worktreeSelector: string) {
    const target = await this.resolveRuntimeFileTarget(worktreeSelector)
    return this.structuredAgentSessionLocationForTarget(target)
  }

  protected structuredAgentSessionLocationForTarget(
    target: Awaited<ReturnType<RuntimeWorkspaceFileTargets['resolveRuntimeFileTarget']>>
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

  /** The one workspace a catalog read names, derived from its selector and the repo rows without
   *  listing worktrees: a model picker's cost must not grow with the fleet. */
  private structuredAgentCatalogTarget(selector: string) {
    const folder = this.resolveFolderWorkspaceSelector(selector)
    if (folder) {
      return {
        worktree: this.folderWorkspaceToResolvedWorktree(folder),
        executionHostId: getConnectionExecutionHostId(
          this.resolveFolderWorkspaceConnectionId(folder)
        )
      }
    }
    let worktreeId = this.getValidatedExplicitWorktreeIdSelector(selector)
    if (selector.startsWith('path:')) {
      const repos = this.selectReposBySelector(selector)
      // The same path on two hosts names no one workspace.
      if (new Set(repos.map(getRepoExecutionHostId)).size !== 1) {
        return null
      }
      worktreeId = composeWorktreeId(repos[0].id, repos[0].path)
    } else if (!worktreeId && splitWorktreeIdForFilesystem(selector)) {
      worktreeId = selector
    }
    const worktree = worktreeId ? this.buildResolvedWorktreeFromId(worktreeId) : null
    return worktree ? this.runtimeFileTargetForWorktree(worktree) : null
  }

  /** The folder a model catalog read may inspect for project settings; null when the selected
   *  workspace is not a native local directory or names no single workspace. */
  async resolveStructuredAgentCatalogWorkspacePath(selector: string): Promise<string | null> {
    try {
      const target = isFloatingWorkspaceSelector(selector)
        ? await this.resolveRuntimeFileTarget(selector)
        : this.structuredAgentCatalogTarget(selector)
      return target && isNativeLocalLocation(this.structuredAgentSessionLocationForTarget(target))
        ? target.worktree.path
        : null
    } catch {
      return null
    }
  }

  /** Where a structured chat here would run, from the same target as its location. */
  async resolveStructuredAgentSessionLocalWorkspacePath(worktreeSelector: string) {
    const target = await this.resolveRuntimeFileTarget(worktreeSelector)
    return isNativeLocalLocation(this.structuredAgentSessionLocationForTarget(target))
      ? target.worktree.path
      : null
  }
}
