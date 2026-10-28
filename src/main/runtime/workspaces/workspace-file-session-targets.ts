import type { OrcaRuntimeWithScheduleMobileSessionTabsChanged } from '../session-tabs/session-tabs-change-publication'
import type { OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree } from '../terminal/launch/terminal-workspace-scope'
import type { OrcaRuntimeWithTransitionGraphReloadToTerminalState } from '../session-graph/session-graph-authority'
import { RuntimeHeadlessTabGroups } from '../session-tabs/headless-tab-group-moves'
import type {
  BrowserTabInfo,
  RuntimeMarkdownReadTabResult,
  RuntimeMarkdownSaveTabResult,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-types'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import type { Repo } from '../../../shared/repo-types'
import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getLocalProjectWorktreeGitOptions } from '../../project-runtime-git-options'
import { resolveWorktreeHostRouting } from '../worktree-launch-host-repo'
import { isFloatingWorkspaceSelector } from '../../../shared/floating-workspace-worktree'
import {
  readMarkdownTabFromDisk,
  saveMarkdownTabToDisk,
  type ListedMarkdownTab,
  type MarkdownTabDiskHost
} from '../markdown-tab-disk-documents'
import { createMarkdownTabDiskHost } from '../markdown-tab-disk-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

export abstract class OrcaRuntimeWithPersistHeadlessTerminalTitle extends RuntimeHeadlessTabGroups {
  protected abstract getListedBrowserTabsByPageId(worktreeId: string): Map<string, BrowserTabInfo>
  protected abstract resolveMobileMarkdownWorktreeId(
    ...args: Parameters<
      OrcaRuntimeWithScheduleMobileSessionTabsChanged['resolveMobileMarkdownWorktreeId']
    >
  ): ReturnType<OrcaRuntimeWithScheduleMobileSessionTabsChanged['resolveMobileMarkdownWorktreeId']>
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
  protected persistHeadlessTerminalTitle(
    worktreeId: string,
    tabId: string,
    title: string | null
  ): void {
    this.updateHeadlessWorkspaceContent(worktreeId, (session) => {
      const tabs = session.tabsByWorktree[worktreeId]
      if (!tabs?.some((tab) => tab.id === tabId)) {
        return null
      }
      return {
        ...session,
        tabsByWorktree: {
          ...session.tabsByWorktree,
          [worktreeId]: tabs.map((tab) => (tab.id === tabId ? { ...tab, customTitle: title } : tab))
        }
      }
    })
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

  protected normalizeMobileSessionTabOrder(
    snapshot: RuntimeMobileSessionTabsSnapshot | undefined,
    targetGroup: RuntimeMobileSessionTabGroup,
    tabOrder: readonly string[]
  ): string[] {
    const normalized: string[] = []
    const seen = new Set<string>()
    for (const tabId of tabOrder) {
      const hostTabId = this.resolveMobileSessionHostTabId(snapshot, tabId)
      if (!hostTabId) {
        throw new Error('invalid_tab_order')
      }
      if (seen.has(hostTabId)) {
        throw new Error('duplicate_tab_order')
      }
      seen.add(hostTabId)
      normalized.push(hostTabId)
    }

    const returnedIds = this.collectPublicMobileSessionTabIds(snapshot)
    const expected = targetGroup.tabOrder
      .map((tabId) => this.resolveMobileSessionHostTabId(snapshot, tabId) ?? tabId)
      // Reorder the sanitized client model; raw groups may contain browser ids hidden from paired web clients.
      .filter((tabId) => returnedIds.has(tabId))
    const structuredIds = expected.filter((tabId) =>
      snapshot?.tabs.some((tab) => tab.type === 'agent-session' && tab.id === tabId)
    )
    if (structuredIds.some((tabId) => !seen.has(tabId))) {
      if (structuredIds.some((tabId) => seen.has(tabId))) {
        throw new Error('invalid_tab_order')
      }
      const visibleExpected = expected.filter((tabId) => !structuredIds.includes(tabId))
      if (
        normalized.length !== visibleExpected.length ||
        visibleExpected.some((tabId) => !seen.has(tabId))
      ) {
        throw new Error('invalid_tab_order')
      }
      for (const tabId of structuredIds) {
        normalized.splice(Math.min(expected.indexOf(tabId), normalized.length), 0, tabId)
      }
      return normalized
    }
    // Only permute this group; missing/extra ids could move or lose host tabs.
    if (normalized.length !== expected.length || expected.some((tabId) => !seen.has(tabId))) {
      throw new Error('invalid_tab_order')
    }
    return normalized
  }

  protected collectPublicMobileSessionTabIds(
    snapshot: RuntimeMobileSessionTabsSnapshot | undefined
  ): Set<string> {
    const ids = new Set<string>()
    if (!snapshot) {
      return ids
    }
    const liveBrowserTabsByPageId = this.getListedBrowserTabsByPageId(snapshot.worktree)
    for (const tab of snapshot.tabs) {
      if (tab.type === 'browser') {
        const liveTab = tab.browserPageId
          ? liveBrowserTabsByPageId.get(tab.browserPageId)
          : undefined
        if (!liveTab) {
          continue
        }
        ids.add(tab.id)
        ids.add(tab.browserWorkspaceId)
        continue
      }
      ids.add(tab.id)
      if (tab.type === 'terminal') {
        ids.add(tab.parentTabId)
      }
    }
    return ids
  }

  protected resolveMobileSessionHostTabId(
    snapshot: RuntimeMobileSessionTabsSnapshot | undefined,
    tabId: string
  ): string | null {
    const tab =
      snapshot?.tabs.find((candidate) => candidate.id === tabId) ??
      snapshot?.tabs.find(
        (candidate) => candidate.type === 'terminal' && candidate.parentTabId === tabId
      ) ??
      snapshot?.tabs.find(
        (candidate) => candidate.type === 'browser' && candidate.browserWorkspaceId === tabId
      )
    if (!tab) {
      return null
    }
    return tab.type === 'terminal' ? tab.parentTabId : tab.id
  }

  async readMobileMarkdownTab(
    worktreeSelector: string,
    tabId: string
  ): Promise<RuntimeMarkdownReadTabResult> {
    const worktreeId = await this.resolveMobileMarkdownWorktreeId(worktreeSelector, tabId)
    return await readMarkdownTabFromDisk(
      this.markdownTabDiskHost(),
      worktreeId,
      this.listedMarkdownTab(worktreeId, tabId)
    )
  }

  async saveMobileMarkdownTab(
    worktreeSelector: string,
    tabId: string,
    baseVersion: string,
    content: string
  ): Promise<RuntimeMarkdownSaveTabResult> {
    const worktreeId = await this.resolveMobileMarkdownWorktreeId(worktreeSelector, tabId)
    return await saveMarkdownTabToDisk(
      this.markdownTabDiskHost(),
      worktreeId,
      this.listedMarkdownTab(worktreeId, tabId),
      baseVersion,
      content
    )
  }

  private listedMarkdownTab(worktreeId: string, tabId: string): ListedMarkdownTab {
    const tab = this.mobileSessionTabsByWorktree
      .get(worktreeId)
      ?.tabs.find((candidate) => candidate.type === 'markdown' && candidate.id === tabId)
    if (tab?.type !== 'markdown') {
      throw new Error('tab_not_found')
    }
    return tab
  }

  private markdownTabDiskHost(): MarkdownTabDiskHost {
    return createMarkdownTabDiskHost({
      requireStore: () => this.requireStore(),
      getWorkspaceSessionForWorktree: (worktreeId) =>
        this.getWorkspaceSessionForWorktree(worktreeId),
      resolveRuntimeFileTarget: (selector) => this.resolveRuntimeFileTarget(selector),
      callEnvironment: (environmentId, method, params, expectedPairingRevision) =>
        this.callOrchestrationWorkerServer(
          environmentId,
          method,
          params,
          undefined,
          undefined,
          expectedPairingRevision === undefined
            ? undefined
            : { expectedEnvironmentPairingRevision: expectedPairingRevision }
        ),
      environmentPairingRevision: (environmentId) =>
        this.resolveOrchestrationWorkerServer(environmentId).pairingRevision
    })
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

    const store = this.requireStore()
    const worktree = await this.resolveGitWorktreeSelector(worktreeSelector)
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
