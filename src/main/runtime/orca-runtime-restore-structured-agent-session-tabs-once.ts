// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { defaultAgentChatLabel } from '../../shared/agent-session-chat-label'
import { OrcaRuntimeWithGetStructuredAgentSessionCreateSupport } from './orca-runtime-get-structured-agent-session-create-support'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { replaceConversationInSnapshot } from './structured-conversation-tab-replacement'
import type { ConversationReplacement } from '../native-chat/agent-session-wire/structured-conversation-command'
import { seedStructuredAgentSessionTabIndex } from './structured-agent-session-tab-index-seed'
import { listedStructuredAgentSessionIds } from './structured-agent-session-startup-step'
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
  /** Projects only: a replacement's chat already has its tab in the store, which the /clear commit
   *  moved in the same write. */
  replaceStructuredAgentSessionTab(replacement: ConversationReplacement): void {
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
      this.projectStructuredAgentSessionTab({
        ...replacement,
        replacesSessionId: replacement.sourceSessionId,
        activate: false
      })
    }
  }

  protected async restoreStructuredAgentSessionTabsOnce(): Promise<void> {
    await this.prepareStructuredAgentSessionStartupRestoration()
    const host = getStructuredAgentSessionHost()
    const listedIds = listedStructuredAgentSessionIds(
      host,
      this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID) ?? null
    )
    for (const worktreeId of this.getKnownWorkspaceSessionWorktreeIds()) {
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
    }
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession()
    const restored = (host?.listSessionTabs(listedIds) ?? []).flatMap((session) => {
      if (session.agent !== 'codex' && session.agent !== 'claude') {
        return []
      }
      let sessionId = session.sessionId
      while (sessionId.startsWith('agent-session:')) {
        sessionId = sessionId.slice('agent-session:'.length)
      }
      return [{ ...session, agent: session.agent, sessionId }]
    })
    await seedStructuredAgentSessionTabIndex(
      host,
      listedIds,
      restored.map((session) => session.sessionId)
    )
    // Past the seed, projecting records nothing.
    // Derived once for the loop below, which stores a snapshot per tab; nothing awaits in between.
    const replacements = host?.conversationReplacements?.() ?? []
    for (const replacement of replacements) {
      this.replaceStructuredAgentSessionTab(replacement)
    }
    const quiet = { activate: false, notify: false, replacements }
    for (const session of restored) {
      this.projectStructuredAgentSessionTab({ ...session, ...quiet })
    }
    // Startup already seeded every settled chat's row and is settling the ones a gone process left
    // with work; this opens only what stored status could not answer (no row yet, a row this build
    // cannot read, a per-chat file not yet copied).
    // Whoever answers with this list starts it, once that answer is out.
    const background = this.structuredAgentSessionBackgroundRestoreIds ?? listedIds
    this.structuredAgentSessionStartupChatWork.oweRestore(
      host
        ? () =>
            void host.restoreReadableSessions(background).catch((error: unknown) => {
              host.deps.logger.warn('restoring chat history after listing failed', {
                scope: 'history-restore-after-listing',
                error
              })
            })
        : null
    )
    const wasUnverifiable = this.structuredAgentSessionInventoryUnverifiable
    // No host, or one still owed the records file's chats, means no one can say which chats exist;
    // with none on disk, empty is the answer.
    const importOwed =
      typeof host?.legacyRecordImportOwed === 'function' && host.legacyRecordImportOwed()
    this.structuredAgentSessionInventoryUnverifiable =
      (!host || importOwed) && this.hasPersistedStructuredAgentSessionStore()
    // This restore published quietly; subscribers still hold the frames that said "cannot tell".
    if (wasUnverifiable && !this.structuredAgentSessionInventoryUnverifiable) {
      this.notifyMobileSessionTabSnapshots()
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
      // The restore index is bookkeeping: one that cannot be written (a newer Orca's records, a
      // failing disk) is reported, and the tab still opens.
      await host
        .setSessionTabVisibility(input.sessionId, true, ...(input.tabId ? [input.tabId] : []))
        .catch((error: unknown) => {
          host.deps.logger.warn('recording an opened chat tab failed', {
            scope: 'tab-visibility-open',
            sessionId: input.sessionId,
            error
          })
        })
    }
    this.projectStructuredAgentSessionTab(input)
  }

  /** The runtime's own snapshot of a chat tab. Records nothing: the caller owns the store write. */
  projectStructuredAgentSessionTab(input: {
    workspaceId: string
    sessionId: string
    agent: 'claude' | 'codex'
    activate: boolean
    notify?: boolean
    replacesSessionId?: string
    /** The /clear replacements, derived once by a caller projecting many tabs in one loop. */
    replacements?: readonly ConversationReplacement[]
  }): void {
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
    const stored = this.storeMobileSessionSnapshot(input.workspaceId, snapshot, input.replacements)
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
