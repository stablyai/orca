// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithGetStructuredAgentSessionCreateSupport } from './orca-runtime-get-structured-agent-session-create-support'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { replaceConversationInSnapshot } from './structured-conversation-tab-replacement'
import type { ConversationReplacement } from '../native-chat/agent-session-wire/structured-conversation-command'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeRepoSearchRefs
} from '../../shared/runtime-types'
import {
  appendStructuredAgentSessionTabs,
  structuredAgentSessionSnapshotTabId,
  type StructuredAgentSessionTabToAppend
} from './structured-agent-session-tab-append'
import { DEFAULT_REPO_SEARCH_REFS_LIMIT } from './orca-runtime-postlude'
import type { Repo } from '../../shared/repo-types'
import type { GitAdmissionTier } from '../git/command-runner/git-exec-options'
import {
  getLocalProjectGhExecOptions,
  resolveLocalProjectRuntimeForRepo,
  type LocalProjectGhExecOptions
} from '../project-runtime-git-options'
import { getAgentLaunchPlatformForRepo } from './runtime-agent-launch-resolution'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { isWslUncPath } from '../../shared/wsl-paths'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'

export class OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce extends OrcaRuntimeWithGetStructuredAgentSessionCreateSupport {
  async replaceStructuredAgentSessionTab(replacement: ConversationReplacement): Promise<void> {
    const prior = this.mobileSessionTabsByWorktree.get(replacement.workspaceId)
    const next = prior ? replaceConversationInSnapshot(prior, replacement) : null
    if (next && next !== prior) {
      const stored = this.storeMobileSessionSnapshot(replacement.workspaceId, next)
      this.emitMobileSessionTabsSnapshot(stored)
    } else if (
      !prior?.tabs.some(
        (tab) => tab.type === 'agent-session' && tab.sessionId === replacement.sessionId
      )
    ) {
      await this.publishStructuredAgentSessionTab({
        ...replacement,
        replacesSessionId: replacement.sourceSessionId,
        activate: false
      })
    }
  }

  // Tab existence needs only the opened store: reconcile, recovery and every journal open run
  // behind the answer, in the startup pass prepare kicks.
  protected async restoreStructuredAgentSessionTabsOnce(): Promise<void> {
    if (this.hasPersistedStructuredAgentSessionStore()) {
      await this.ensureStructuredAgentSessionHost()
      void this.prepareStructuredAgentSessionStartupRestoration().catch((error) => {
        console.error('[structured-agent-session] startup restoration failed', error)
      })
    }
    const host = getStructuredAgentSessionHost()
    for (const worktreeId of this.getKnownWorkspaceSessionWorktreeIds()) {
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
    }
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession()
    for (const replacement of host?.conversationReplacements?.() ?? []) {
      await this.replaceStructuredAgentSessionTab(replacement)
    }
    this.publishListedStructuredAgentSessionTabs(host)
  }

  /** Every listed chat in one store write per workspace, from the index and the records alone.
   *  Synchronous from the index read to the last store, so a close lands wholly before or after. */
  private publishListedStructuredAgentSessionTabs(host): void {
    if (
      typeof host?.listVisibleSessionIds !== 'function' ||
      typeof host.listPersistedSessionTabs !== 'function'
    ) {
      return
    }
    const byWorkspace = new Map<string, StructuredAgentSessionTabToAppend[]>()
    for (const tab of host.listPersistedSessionTabs(host.listVisibleSessionIds())) {
      if (tab.agent !== 'codex' && tab.agent !== 'claude') {
        continue
      }
      let sessionId = tab.sessionId
      while (sessionId.startsWith('agent-session:')) {
        sessionId = sessionId.slice('agent-session:'.length)
      }
      const tabs = byWorkspace.get(tab.workspaceId) ?? []
      tabs.push({ sessionId, agent: tab.agent })
      byWorkspace.set(tab.workspaceId, tabs)
    }
    for (const [workspaceId, tabs] of byWorkspace) {
      const next = appendStructuredAgentSessionTabs(
        this.mobileSessionTabsByWorktree.get(workspaceId),
        workspaceId,
        tabs,
        { activate: false }
      )
      if (next) {
        this.storeMobileSessionSnapshot(workspaceId, next)
      }
    }
  }

  async publishStructuredAgentSessionTab(input: {
    workspaceId: string
    sessionId: string
    agent: 'claude' | 'codex'
    activate: boolean
    notify?: boolean
    replacesSessionId?: string
    /** The host tab id a create reserved; a session that already has a tab keeps its own. */
    tabId?: string
  }): Promise<void> {
    const host = getStructuredAgentSessionHost()
    if (typeof host?.setSessionTabVisibility === 'function') {
      await host.setSessionTabVisibility(
        input.sessionId,
        true,
        ...(input.tabId ? [input.tabId] : [])
      )
    }
    const existing = this.mobileSessionTabsByWorktree.get(input.workspaceId)
    const id = structuredAgentSessionSnapshotTabId(input.sessionId)
    if (existing?.tabs.some((tab) => tab.id === id)) {
      // A background re-publish is a no-op — no store write, no emit — so it cannot re-surface a
      // client whose mirror lost the tab; healing one needs `activate` or an explicit republish.
      if (!input.activate) {
        return
      }
      const priorGroups = existing.tabGroups ?? []
      const groupId =
        priorGroups.find((group) => group.tabOrder.includes(id))?.id ??
        (priorGroups.some((group) => group.id === existing.activeGroupId)
          ? existing.activeGroupId
          : priorGroups[0]?.id)
      const snapshot: RuntimeMobileSessionTabsSnapshot = {
        ...existing,
        snapshotVersion: existing.snapshotVersion + 1,
        activeGroupId: groupId ?? existing.activeGroupId,
        activeTabId: id,
        activeTabType: 'agent-session',
        tabGroups: priorGroups.map((group) =>
          group.id === groupId ? { ...group, activeTabId: id } : group
        ),
        tabs: existing.tabs.map((tab) => ({ ...tab, isActive: tab.id === id }))
      }
      const stored = this.storeMobileSessionSnapshot(input.workspaceId, snapshot)
      if (input.notify !== false) {
        this.emitMobileSessionTabsSnapshot(stored)
      }
      return
    }
    const snapshot = appendStructuredAgentSessionTabs(
      existing,
      input.workspaceId,
      [
        {
          sessionId: input.sessionId,
          agent: input.agent,
          ...(input.replacesSessionId ? { replacesSessionId: input.replacesSessionId } : {})
        }
      ],
      { activate: input.activate }
    )
    if (!snapshot) {
      return
    }
    const stored = this.storeMobileSessionSnapshot(input.workspaceId, snapshot)
    if (input.notify !== false) {
      this.emitMobileSessionTabsSnapshot(stored)
    }
  }

  async inspectTerminalProcess(
    terminalSelector: string,
    options?: { expectedIncarnationId?: string; scanChildProcesses?: boolean }
  ): Promise<PtyProcessInspection> {
    const leaf = this.resolveLiveLeafForHandle(terminalSelector)
    if (!leaf?.ptyId || !this.ptyController) {
      throw new Error('terminal_gone')
    }
    if (this.ptyController.inspectProcess) {
      // Preserve the legacy one-argument call shape when no incarnation
      // fence was requested; some providers use arity to distinguish the
      // compatibility path from the fenced remote inspection.
      const inspection =
        options === undefined
          ? await this.ptyController.inspectProcess(leaf.ptyId)
          : await this.ptyController.inspectProcess(leaf.ptyId, options)
      const evidence = inspection.foregroundProcessEvidence
      // The runtime handle is the request identity on this wire; keep the
      // host-owned leaf PTY id out of the client-facing comparison.
      const relayPtyId = parseAppSshPtyId(leaf.ptyId)?.relayPtyId
      const evidenceBelongsToLeaf =
        evidence !== undefined && (evidence.ptyId === leaf.ptyId || evidence.ptyId === relayPtyId)
      return evidenceBelongsToLeaf
        ? { ...inspection, foregroundProcessEvidence: { ...evidence, ptyId: terminalSelector } }
        : inspection
    }
    const foregroundProcess = await this.ptyController.getForegroundProcess(leaf.ptyId)
    const hasChildProcesses = (await this.ptyController.hasChildProcesses?.(leaf.ptyId)) ?? false
    return { foregroundProcess, hasChildProcesses }
  }

  async searchRepoRefs(
    repoSelector: string,
    query: string,
    limit = DEFAULT_REPO_SEARCH_REFS_LIMIT
  ): Promise<RuntimeRepoSearchRefs> {
    return this.repositoryRefQueries.search(repoSelector, query, limit)
  }

  protected async resolveHostedReviewTarget(args: {
    repoSelector: string
    worktreeSelector?: string
  }): Promise<{ repo: Repo; repoPath: string }> {
    const repo = await this.resolveRepoSelector(args.repoSelector)
    if (!args.worktreeSelector) {
      return { repo, repoPath: repo.path }
    }

    const worktree = await this.resolveWorktreeSelector(args.worktreeSelector)
    if (worktree.repoId !== repo.id) {
      throw new Error('Access denied: worktree does not belong to repository')
    }
    return { repo, repoPath: worktree.path }
  }

  protected getHostedReviewExecutionOptions(
    repo: Repo,
    admissionTier?: GitAdmissionTier
  ):
    | { localGitExecOptions: LocalProjectGhExecOptions & { admissionTier?: GitAdmissionTier } }
    | undefined {
    const localGitOptions = {
      ...this.getLocalGitExecutionOptionArgs(repo)[0],
      ...(admissionTier && { admissionTier })
    }
    return Object.keys(localGitOptions).length > 0
      ? { localGitExecOptions: localGitOptions }
      : undefined
  }

  protected getLocalGitExecutionOptionArgs(repo: Repo): [] | [LocalProjectGhExecOptions] {
    const localGitOptions = getLocalProjectGhExecOptions(this.requireStore(), repo)
    return Object.keys(localGitOptions).length > 0 ? [localGitOptions] : []
  }

  protected getAgentLaunchPlatformForRepo(repo: Repo): NodeJS.Platform {
    const projectRuntime = repo.connectionId
      ? undefined
      : resolveLocalProjectRuntimeForRepo(this.requireStore(), repo)
    return getAgentLaunchPlatformForRepo(repo, projectRuntime)
  }

  protected getAgentLaunchPlatformForWorkspace(
    scope: TerminalWorkspaceLaunchScope
  ): NodeJS.Platform {
    if (scope.repo) {
      return this.getAgentLaunchPlatformForRepo(scope.repo)
    }
    if (scope.connectionId) {
      return isWindowsAbsolutePathLike(scope.path) ? 'win32' : 'linux'
    }
    return isWslUncPath(scope.path) ? 'linux' : process.platform
  }
}
