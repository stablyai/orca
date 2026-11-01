import {
  admitStructuredSessionTabPublication,
  projectStructuredSessionTab,
  type StructuredSessionRawPublicationInput,
  type StructuredSessionTabPublicationInput
} from './structured-session-tab-publication'
import type { OrcaRuntimeWithScheduleMobileSessionTabsChanged as ScheduleMobileSessionTabsChangedMethods } from './session-tabs-change-publication'
import { OrcaRuntimeWithGetStructuredAgentSessionCreateSupport } from './structured-session-create-support'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { restoredChatTabChanges } from './restored-chat-tab-changes'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { RuntimeRepoSearchRefs } from '../../../shared/runtime-types'
import { DEFAULT_REPO_SEARCH_REFS_LIMIT } from '../orca-runtime-postlude'
import type { Repo } from '../../../shared/repo-types'
import type { GitAdmissionTier } from '../../git/command-runner/git-exec-options'
import {
  getLocalProjectGhExecOptions,
  type LocalProjectGhExecOptions
} from '../../project-runtime-git-options'
import {
  agentLaunchPlatformForScope,
  newWorktreeLaunchScope,
  resolveAgentLaunchRuntime,
  resolveStartupAgentLaunchRuntime
} from '../agent-launch-scope-runtime'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentLaunchRuntime } from '../../../shared/agent-launch-runtime'
import type { TerminalWorkspaceLaunchScope } from '../runtime-legacy-worker-terminal-recovery-types'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { PtyProcessInspection } from '../../providers/pty-process-inspection'

export type AgentLaunchScope = Parameters<
  OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce['getAgentLaunchPlatformForWorkspace']
>[0]

export abstract class OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce extends OrcaRuntimeWithGetStructuredAgentSessionCreateSupport {
  protected abstract notifyMobileSessionTabSnapshots(
    ...args: Parameters<ScheduleMobileSessionTabsChangedMethods['notifyMobileSessionTabSnapshots']>
  ): ReturnType<ScheduleMobileSessionTabsChangedMethods['notifyMobileSessionTabSnapshots']>

  protected async restoreStructuredAgentSessionTabsOnce(): Promise<void> {
    await this.prepareStructuredAgentSessionStartupRestoration()
    const host = getStructuredAgentSessionHost()
    if (host?.getPersistedVisibleSessionTabIndex?.().present !== true) {
      await host?.deps?.store?.initializeSessionTabs?.().catch((error: unknown) =>
        host.deps.logger.warn('recording restored chat tabs failed', {
          scope: 'tab-index-seed',
          error
        })
      )
    }
    await host?.seedSessionTabs()
    for (const worktreeId of this.getKnownWorkspaceSessionWorktreeIds()) {
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
    }
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession()
    // Every session here is of an agent this host registered: its store holds no other agent's records.
    const restored = (host?.listSessionTabs() ?? []).flatMap((session) => {
      let sessionId = session.sessionId
      while (sessionId.startsWith('agent-session:')) {
        sessionId = sessionId.slice('agent-session:'.length)
      }
      return [{ ...session, agent: session.agent, sessionId }]
    })
    const changes = restoredChatTabChanges(
      this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)?.unifiedTabs ?? {},
      host,
      restored,
      (id) => this.hasCurrentLocalStructuredSessionTab(id)
    )
    for (const [worktreeId, worktreeChanges] of changes) {
      this.changeWindowlessChatTabs(worktreeId, worktreeChanges, (change) =>
        this.passiveStructuredSessionTabChangeEligible(change)
      )
    }
    for (const session of restored) {
      if (host?.isSessionTabVisible(session.sessionId)) {
        this.projectStructuredAgentSessionTab({ ...session, activate: false, notify: false })
      }
    }
    const wasUnverifiable = this.structuredAgentSessionInventoryUnverifiable
    // No host means no one can say which chats exist; with none on disk, empty is the answer.
    this.structuredAgentSessionInventoryUnverifiable =
      !host && this.hasPersistedStructuredAgentSessionStore()
    // This restore published quietly; subscribers still hold the frames that said "cannot tell".
    if (wasUnverifiable && !this.structuredAgentSessionInventoryUnverifiable) {
      this.notifyMobileSessionTabSnapshots()
    }
  }

  async publishStructuredAgentSessionTab(
    input: StructuredSessionTabPublicationInput
  ): Promise<void> {
    input.workspaceAuthority?.check()
    const { tabId, current, eligible } = await admitStructuredSessionTabPublication(input, () =>
      input.workspaceAuthority
        ? this.prepareStructuredAgentSessionStartupRestoration()
        : this.restoreStructuredAgentSessionTabs()
    )
    if (!eligible()) {
      throw new Error('Chat tab publication was superseded')
    }
    // Window creates retain the window's own placement decision.
    if (!(ORCA_LAYOUT_OWNER_IS_MAIN && input.placedByWindow)) {
      const saving = this.saveWindowlessAgentSessionTab(input.workspaceId, {
        ...input,
        eligible,
        ...(tabId ? { tabId } : {})
      })
      input.workspaceAuthority?.saving(saving)
    }
    this.projectStructuredAgentSessionTab({ ...input, tabId, eligible })
    input.workspaceAuthority?.committed()
    if (!eligible()) {
      throw new Error('Chat tab publication was superseded')
    }
    input.capture?.({
      tableId: current ?? null,
      presentation: {
        raw: this.currentLocalStructuredSessionPresentation(input.sessionId),
        saved:
          ORCA_LAYOUT_OWNER_IS_MAIN && input.placedByWindow
            ? []
            : [{ worktreeId: input.workspaceId, tabId }]
      }
    })
  }

  /** The caller owns the store write; this publishes only its current raw surface. */
  projectStructuredAgentSessionTab(input: StructuredSessionRawPublicationInput): void {
    projectStructuredSessionTab(this, input, (snapshot) =>
      this.emitMobileSessionTabsSnapshot(snapshot)
    )
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
      // Preserve one-argument unfenced calls; providers may use arity to select legacy versus fenced inspection.
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
    limit = DEFAULT_REPO_SEARCH_REFS_LIMIT,
    includeQualifiedRefs = true
  ): Promise<RuntimeRepoSearchRefs> {
    return this.repositoryRefQueries.search(repoSelector, query, limit, includeQualifiedRefs)
  }

  protected async resolveHostedReviewTarget(args: {
    repoSelector: string
    worktreeSelector?: string
  }): Promise<{ repo: Repo; repoPath: string }> {
    const repo = await this.resolveRepoSelector(args.repoSelector)
    if (!args.worktreeSelector) {
      return { repo, repoPath: repo.path }
    }

    const worktree = await this.resolveGitWorktreeSelector(args.worktreeSelector)
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

  protected getAgentLaunchPlatformForWorkspace(
    scope: Pick<TerminalWorkspaceLaunchScope, 'repo' | 'path'> & {
      connectionId?: string | null
    }
  ): NodeJS.Platform {
    // Orchestration passes a repo-only scope; the platform never reads its id or folder.
    return agentLaunchPlatformForScope(this.requireStore(), {
      id: '',
      folderWorkspace: null,
      ...scope,
      connectionId: scope.connectionId ?? null
    })
  }

  protected resolveAgentLaunchRuntime(
    scope: TerminalWorkspaceLaunchScope,
    agent: TuiAgent | undefined
  ): AgentLaunchRuntime {
    return resolveAgentLaunchRuntime(this.requireStore(), scope, undefined, agent)
  }

  /** A startup's fact: the workspace it starts in, else the new worktree a create is making. */
  protected resolveStartupAgentLaunchRuntime(
    repo: Repo,
    agent: TuiAgent,
    scope?: TerminalWorkspaceLaunchScope
  ): ReturnType<typeof resolveStartupAgentLaunchRuntime> {
    const store = this.requireStore()
    return resolveStartupAgentLaunchRuntime(
      store,
      scope ?? newWorktreeLaunchScope(repo, store.getSettings()),
      agent
    )
  }
}
