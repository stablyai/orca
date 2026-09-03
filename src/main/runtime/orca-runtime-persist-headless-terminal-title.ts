// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithMoveHeadlessMobileSessionTab } from './orca-runtime-move-headless-mobile-session-tab'
import type {
  RuntimeMarkdownReadTabResult,
  RuntimeMarkdownSaveTabResult,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { Repo } from '../../shared/repo-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { resolveWorktreeHostRouting } from './worktree-launch-host-repo'

export class OrcaRuntimeWithPersistHeadlessTerminalTitle extends OrcaRuntimeWithMoveHeadlessMobileSessionTab {
  // Persist a manual terminal rename so a headless rebuild keeps the title
  // instead of reverting to the generated/default one.
  protected persistHeadlessTerminalTitle(
    worktreeId: string,
    tabId: string,
    title: string | null
  ): void {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      return
    }
    const tabs = session.tabsByWorktree[worktreeId]
    if (!tabs?.some((tab) => tab.id === tabId)) {
      return
    }
    this.setWorkspaceSessionForWorktree(worktreeId, {
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [worktreeId]: tabs.map((tab) => (tab.id === tabId ? { ...tab, customTitle: title } : tab))
      }
    })
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
      // Why: clients reorder the sanitized session.tabs.list model; raw groups
      // can still contain stale browser ids hidden from paired web clients.
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
    // Why: reorder is a pure permutation of one existing group. Missing or
    // extra ids would let a paired web client silently move/lose host tabs.
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
    const liveBrowserTabsByPageId = this.getLiveBrowserTabsByPageId(snapshot.worktree)
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
    if (!this.notifier?.readMobileMarkdownTab) {
      throw new Error('renderer_unavailable')
    }
    return await this.notifier.readMobileMarkdownTab(worktreeId, tabId)
  }

  async saveMobileMarkdownTab(
    worktreeSelector: string,
    tabId: string,
    baseVersion: string,
    content: string
  ): Promise<RuntimeMarkdownSaveTabResult> {
    const worktreeId = await this.resolveMobileMarkdownWorktreeId(worktreeSelector, tabId)
    if (!this.notifier?.saveMobileMarkdownTab) {
      throw new Error('renderer_unavailable')
    }
    return await this.notifier.saveMobileMarkdownTab(worktreeId, tabId, baseVersion, content)
  }

  // Why: `getRepo(id)` is host-blind and never read `worktree.hostId`, which outranks every repo
  // row. One id can name rows on local, SSH and runtime hosts at once, so an arbitrary row decided
  // the execution host for ~36 downstream Git dispatches: a worktree on one SSH host routed to
  // another, and a runtime host's *nested* target got dialled in this client's namespace (#11163).
  protected async resolveRuntimeGitTarget(worktreeSelector: string): Promise<{
    worktree: ResolvedWorktree
    repo?: Repo
    executionHostId: ExecutionHostId
    localGitOptions?: { wslDistro?: string }
  }> {
    const store = this.requireStore()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
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

  // Why: same defect as `resolveRuntimeGitTarget` above, in ~30 filesystem dispatches. `getRepo(id)`
  // is host-blind and never read `worktree.hostId`, and the `connectionId` it returned spelled
  // "runtime host", "unresolved" and "genuinely local" all as `undefined` (#11163).
  protected async resolveRuntimeFileTarget(worktreeSelector: string): Promise<{
    worktree: ResolvedWorktree
    executionHostId: ExecutionHostId
  }> {
    const folderScope = await this.resolveFolderWorkspaceLaunchScope(worktreeSelector)
    if (folderScope?.folderWorkspace) {
      // A folder workspace has no repo row to disagree with; its own inference already threw on an
      // ambiguous one, and it is never hosted by a runtime environment.
      return {
        worktree: this.folderWorkspaceToResolvedWorktree(folderScope.folderWorkspace),
        executionHostId: folderScope.connectionId
          ? toSshExecutionHostId(folderScope.connectionId)
          : LOCAL_EXECUTION_HOST_ID
      }
    }

    const store = this.requireStore()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
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
