import type { OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree } from '../terminal/launch/terminal-workspace-scope'
import type { OrcaRuntimeWithTransitionGraphReloadToTerminalState } from '../session-graph/session-graph-authority'
import type { ResolvedWorktree } from './catalog/runtime-worktree-path-identity'
import type { Repo } from '../../../shared/repo-types'
import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getLocalProjectWorktreeGitOptions } from '../../workspaces/execution-host/project-runtime-git-options'
import { resolveWorktreeHostRouting } from './catalog/worktree-launch-host-repo'
import { isFloatingWorkspaceSelector } from '../../../shared/floating-workspace-worktree'
import { getLatestLeafTitle, getLeafDisplayRecord } from './process-listing/runtime-worktree-status-projection'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { RuntimeMarkdownTabOperations } from '../files/paths/runtime-markdown-tab-operations'

export abstract class RuntimeWorkspaceFileTargets extends RuntimeMarkdownTabOperations {
  protected abstract floatingWorkspaceToResolvedWorktree(
    ...args: Parameters<
      OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree['floatingWorkspaceToResolvedWorktree']
    >
  ): ReturnType<
    OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree['floatingWorkspaceToResolvedWorktree']
  >

  protected abstract resolveFloatingWorkspacePath(
    ...args: Parameters<
      OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree['resolveFloatingWorkspacePath']
    >
  ): ReturnType<
    OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree['resolveFloatingWorkspacePath']
  >

  protected abstract resolveFolderWorkspaceLaunchScope(
    ...args: Parameters<
      OrcaRuntimeWithTransitionGraphReloadToTerminalState['resolveFolderWorkspaceLaunchScope']
    >
  ): ReturnType<
    OrcaRuntimeWithTransitionGraphReloadToTerminalState['resolveFolderWorkspaceLaunchScope']
  >

  // Persist a manual terminal rename so a headless rebuild keeps the title
  // instead of reverting to the generated/default one.
  protected override persistHeadlessTerminalTitle(
    worktreeId: string,
    tabId: string,
    title: string | null
  ): void {
    const normalizedTitle = title?.trim() || null
    let fallbackTitle: string | null = null
    if (normalizedTitle === null) {
      for (const leaf of this.leaves.values()) {
        if (leaf.tabId === tabId) {
          const pty = leaf.ptyId ? this.ptysById.get(leaf.ptyId) : undefined
          fallbackTitle =
            getLatestLeafTitle(getLeafDisplayRecord(leaf, null), null) ?? pty?.title ?? null
          break
        }
      }
    }
    const inMemoryTab = this.tabs.get(tabId)
    if (inMemoryTab) {
      inMemoryTab.customTitle = normalizedTitle
      inMemoryTab.title = normalizedTitle ?? fallbackTitle ?? 'Terminal'
    }
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (snapshot) {
      snapshot.tabs = snapshot.tabs.map((tab) => {
        if (tab.type === 'terminal' && tab.parentTabId === tabId) {
          return {
            ...tab,
            customTitle: normalizedTitle,
            title: normalizedTitle ?? fallbackTitle ?? 'Terminal'
          }
        }
        if (tab.type === 'agent-session' && tab.id === tabId) {
          return {
            ...tab,
            customTitle: normalizedTitle,
            ...(normalizedTitle ? { title: normalizedTitle } : {})
          }
        }
        return tab
      })
    }
    this.updateHeadlessWorkspaceContent(worktreeId, (session) => {
      const tabs = session.tabsByWorktree[worktreeId]
      if (!tabs?.some((tab) => tab.id === tabId)) {
        return null
      }
      return {
        ...session,
        tabsByWorktree: {
          ...session.tabsByWorktree,
          [worktreeId]: tabs.map((tab) =>
            tab.id === tabId
              ? {
                  ...tab,
                  customTitle: normalizedTitle,
                  ...(normalizedTitle === null && fallbackTitle !== null
                    ? { title: fallbackTitle }
                    : {})
                }
              : tab
          )
        }
      }
    })
    const sessionId = this.resolveSessionIdForTab(tabId)
    if (sessionId) {
      this.setSessionCustomTitle(sessionId, normalizedTitle)
    }
  }

  private updateHeadlessWorkspaceContent(
    worktreeId: string,
    update: (session: WorkspaceSessionState) => WorkspaceSessionState | null
  ): void {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      return
    }
    const write = this.setWorkspaceSessionForWorktree.bind(this)
    const next = update(session)
    if (next) {
      write(worktreeId, next)
    }
  }

  // Route by worktree host before repo id: same-id host twins and runtime-nested targets cannot use this client's arbitrary repo row (#11163).
  protected async resolveRuntimeGitTarget(worktreeSelector: string): Promise<{
    worktree: ResolvedWorktree
    repo?: Repo
    executionHostId: ExecutionHostId
    localGitOptions?: { wslDistro?: string }
  }> {
    const store = this.requireStore()
    const worktree = await this.resolveGitWorktreeSelector(worktreeSelector)
    const routing = resolveWorktreeHostRouting(store.getRepos(), worktree)
    if (routing.kind === 'ambiguous') {
      throw new Error('worktree_execution_host_unresolved')
    }
    const executionHostId = routing.kind === 'resolved' ? routing.hostId : LOCAL_EXECUTION_HOST_ID
    // Metadata only (shared-link paths, source-control AI defaults); routing is `executionHostId`.
    const repo =
      (routing.kind === 'resolved' ? routing.repo : null) ?? store.getRepo(worktree.repoId)
    const localGitOptions =
      repo && executionHostId === LOCAL_EXECUTION_HOST_ID
        ? getLocalProjectWorktreeGitOptions(store, repo)
        : {}
    return { worktree, repo, executionHostId, localGitOptions }
  }

  // Resolve the worktree's filesystem host; getRepo(id) conflates host twins, runtime targets, unresolved owners and local paths (#11163).
  async resolveRuntimeFileTarget(worktreeSelector: string): Promise<{
    worktree: ResolvedWorktree
    executionHostId: ExecutionHostId
  }> {
    // Floating workspaces have no row; resolve their authority centrally.
    if (isFloatingWorkspaceSelector(worktreeSelector)) {
      return {
        worktree: this.floatingWorkspaceToResolvedWorktree(
          await this.resolveFloatingWorkspacePath()
        ),
        executionHostId: LOCAL_EXECUTION_HOST_ID
      }
    }
    const folderScope = await this.resolveFolderWorkspaceLaunchScope(worktreeSelector)
    if (folderScope?.folderWorkspace) {
      // Folder inference already rejects ambiguity; no repo row or runtime-environment owner can override it.
      return {
        worktree: this.folderWorkspaceToResolvedWorktree(folderScope.folderWorkspace),
        executionHostId: getConnectionExecutionHostId(folderScope.connectionId)
      }
    }

    return this.runtimeFileTargetForWorktree(
      await this.resolveGitWorktreeSelector(worktreeSelector)
    )
  }

  protected runtimeFileTargetForWorktree(worktree: ResolvedWorktree): {
    worktree: ResolvedWorktree
    executionHostId: ExecutionHostId
  } {
    const store = this.requireStore()
    const routing = resolveWorktreeHostRouting(store.getRepos(), worktree)
    if (routing.kind === 'ambiguous') {
      throw new Error('worktree_execution_host_unresolved')
    }
    return {
      worktree,
      executionHostId: routing.kind === 'resolved' ? routing.hostId : LOCAL_EXECUTION_HOST_ID
    }
  }
}
