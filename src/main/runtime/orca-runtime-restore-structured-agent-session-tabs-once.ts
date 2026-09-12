// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { defaultAgentChatLabel } from '../../shared/agent-session-chat-label'
import { OrcaRuntimeWithResolveRecoveredStructuredTuiTranscript } from './orca-runtime-resolve-recovered-structured-tui-transcript'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { replaceConversationInSnapshot } from './structured-conversation-tab-replacement'
import type { ConversationReplacement } from '../native-chat/agent-session-wire/structured-conversation-command'
import { collectSavedStructuredAgentSessionIds } from './saved-structured-agent-session-restoration'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeRepoSearchRefs
} from '../../shared/runtime-types'
import { getHeadlessMobileSessionGroupId } from './mobile-session-layout-projection'
import { DEFAULT_REPO_SEARCH_REFS_LIMIT } from './orca-runtime-postlude'
import type { Repo } from '../../shared/repo-types'
import type { GitAdmissionTier } from '../git/command-runner/git-exec-options'
import {
  getLocalProjectWorktreeGitOptions,
  resolveLocalProjectRuntimeForRepo
} from '../project-runtime-git-options'
import { getAgentLaunchPlatformForRepo } from './runtime-agent-launch-resolution'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { isWslUncPath } from '../../shared/wsl-paths'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'

export class OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce extends OrcaRuntimeWithResolveRecoveredStructuredTuiTranscript {
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

  protected async restoreStructuredAgentSessionTabsOnce(): Promise<void> {
    await this.prepareStructuredAgentSessionStartupRestoration()
    const host = getStructuredAgentSessionHost()
    const persistedVisibleIndex =
      typeof host?.getPersistedVisibleSessionTabIndex === 'function'
        ? host.getPersistedVisibleSessionTabIndex()
        : { present: false, sessionIds: [] }
    const profileIds = collectSavedStructuredAgentSessionIds(
      this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID) ?? null
    )
    await host?.restoreReadableSessions(
      persistedVisibleIndex.present ? persistedVisibleIndex.sessionIds : profileIds
    )
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
    for (const session of host?.listSessionTabs() ?? []) {
      if (session.agent !== 'codex' && session.agent !== 'claude') {
        continue
      }
      let sessionId = session.sessionId
      while (sessionId.startsWith('agent-session:')) {
        sessionId = sessionId.slice('agent-session:'.length)
      }
      await this.publishStructuredAgentSessionTab({
        ...session,
        agent: session.agent,
        sessionId,
        activate: false,
        notify: false
      })
    }
  }

  async publishStructuredAgentSessionTab(input: {
    workspaceId: string
    sessionId: string
    agent: 'claude' | 'codex'
    activate: boolean
    notify?: boolean
    replacesSessionId?: string
  }): Promise<void> {
    const host = getStructuredAgentSessionHost()
    if (typeof host?.setSessionTabVisibility === 'function') {
      await host.setSessionTabVisibility(input.sessionId, true)
    }
    const existing = this.mobileSessionTabsByWorktree.get(input.workspaceId)
    const id = `agent-session:${input.sessionId}`
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
    const tab: RuntimeMobileSessionAgentTab = {
      type: 'agent-session',
      id,
      title: defaultAgentChatLabel(input.agent),
      sessionId: input.sessionId,
      ...(input.replacesSessionId ? { replacesSessionId: input.replacesSessionId } : {}),
      agent: input.agent,
      isActive: input.activate
    }
    const tabs = [...(existing?.tabs ?? [])].map((candidate) => ({
      ...candidate,
      isActive: input.activate ? false : candidate.isActive
    }))
    tabs.push(tab)
    const priorGroups = existing?.tabGroups ?? [
      {
        id: getHeadlessMobileSessionGroupId(input.workspaceId),
        activeTabId: existing?.activeTabId ?? null,
        tabOrder: []
      }
    ]
    const groupId = priorGroups.some((group) => group.id === existing?.activeGroupId)
      ? existing!.activeGroupId!
      : priorGroups[0]!.id
    const tabGroups = priorGroups.map((group) =>
      group.id === groupId
        ? {
            ...group,
            activeTabId: input.activate ? id : group.activeTabId,
            tabOrder: [...group.tabOrder, id]
          }
        : group
    )
    const snapshot: RuntimeMobileSessionTabsSnapshot = {
      worktree: input.workspaceId,
      publicationEpoch: existing?.publicationEpoch ?? `structured:${Date.now().toString(36)}`,
      snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
      activeGroupId: input.activate ? groupId : (existing?.activeGroupId ?? groupId),
      activeTabId: input.activate ? id : (existing?.activeTabId ?? null),
      activeTabType: input.activate ? 'agent-session' : (existing?.activeTabType ?? null),
      tabGroups,
      ...(existing?.tabGroupLayout ? { tabGroupLayout: existing.tabGroupLayout } : {}),
      tabs
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
    | {
        localGitExecOptions: {
          wslDistro?: string
          admissionTier?: GitAdmissionTier
        }
      }
    | undefined {
    const localGitOptions = {
      ...this.getLocalGitExecutionOptionArgs(repo)[0],
      ...(admissionTier && { admissionTier })
    }
    return Object.keys(localGitOptions).length > 0
      ? { localGitExecOptions: localGitOptions }
      : undefined
  }

  protected getLocalGitExecutionOptionArgs(repo: Repo): [] | [{ wslDistro?: string }] {
    const localGitOptions = getLocalProjectWorktreeGitOptions(this.requireStore(), repo)
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
