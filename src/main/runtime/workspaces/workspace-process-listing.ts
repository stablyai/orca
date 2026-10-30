import { resolveHostStructuredAgentLaunchEnvironment } from '../structured-agent-launch-support'
import { resolveStructuredCodexAccountKind } from '../structured-agent-account-home'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { collectRuntimeWorktreeAgentSources } from '../runtime-worktree-agent-sources'
import { OrcaRuntimeWithWorktreePsDependencies } from './workspace-process-listing-dependencies'
import { DEFAULT_WORKTREE_PS_LIMIT } from '../orca-runtime-postlude'
import type { RuntimeWorktreePsResult } from '../../../shared/runtime-types'
import type { ResolvedWorktreeSnapshot } from '../runtime-resolved-worktree-cache'
import { buildRuntimeWorktreePsSummaries } from '../runtime-worktree-ps-summaries'
import {
  buildRuntimeWorktreeSummaryPathIndex,
  createRuntimeWorktreePsSummaryLookup
} from '../runtime-worktree-summary-paths'
import {
  applyRuntimeWorktreePsSessionActivity,
  applyRuntimeWorktreePsTerminalActivity
} from '../runtime-worktree-ps-activity'
import { applyRuntimeWorktreePsUnverifiableTerminals } from '../runtime-worktree-ps-unverifiable-terminals'
import { attachRuntimeWorktreeAgentRows } from '../runtime-worktree-agent-rows'
import { attachRuntimeWorktreeAgentRowWaits } from '../runtime-worktree-agent-row-waits'
import { compareWorktreePs } from '../runtime-worktree-status-projection'
import type { Repo } from '../../../shared/repo-types'
import { enrichMissingRepoGitRemoteIdentities } from '../../repo-git-remote-identity-enrichment'
import { ensureStructuredAgentSessionHost as installStructuredAgentSessionHost } from '../structured-agent-session-runtime'
import {
  createStructuredAttentionMobileDelivery,
  readStructuredAttentionWorkspaceLabels
} from '../structured-agent-session-mobile-attention'
import {
  createStructuredAgentSessionLogger,
  neverThrowingStructuredAgentSessionLogger
} from '../../native-chat/agent-session-wire/structured-agent-session-logger'
import { openAgentSessionRecordStoreOnce } from '../agent-session-record-store-slot'
import type { AgentSessionRecordStore } from '../agent-session-record-store'
import { maybeAutoRenameWorkspaceOnFirstStructuredTurn } from '../../agent-hooks/first-work-structured-session-rename'
import { firstWorkRenameDeps } from '../../agent-hooks/first-work-rename-runtime'
import { createStructuredChatNamingHandler } from '../../native-chat/structured-chat-naming'
import { structuredChatNamingDeps } from '../structured-chat-naming-runtime'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { escalateChatWorkerError } from '../orchestration/chat-worker-error-escalation'
import type { StructuredAgentSessionRequestFailure } from '../../native-chat/agent-session-wire/structured-agent-session-request-failures'
import { buildWorktreeListingPage } from '../worktree-listing-host-scope'
import {
  structuredWorkerOpenTaskTitle,
  structuredWorkerOwesWork
} from '../structured-worker-custody'
import { preModeChatGetsFullAccess } from '../../../shared/agent-chat-permission-mode'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import { nativeChatShellEnvironmentPolicy } from '../../../shared/native-chat/native-chat-shell-environment'
import { claudeStructuredAuthPolicyForSettings } from '../../claude-accounts/claude-structured-auth-policy'
import { resolveStructuredAgentCommand } from '../../native-chat/structured-agent-command-resolution'
import { structuredAgentConfiguredArgs } from '../../native-chat/structured-agent-configured-args'
import { claudeCliFlagSupport } from '../../claude/claude-cli-flag-support'
import {
  runtimeHiddenHostIds,
  runtimeHiddenRepos,
  runtimeVisibleRepos,
  withoutHiddenHosts
} from '../runtime-visible-catalog'
import { isWorkspaceNotificationMuted } from '../workspace-notification-mute'

export abstract class OrcaRuntimeWithGetWorktreePs extends OrcaRuntimeWithWorktreePsDependencies {
  async getWorktreePs(
    limit = DEFAULT_WORKTREE_PS_LIMIT,
    sourceDefaultsSupported = true,
    includeAgentWait = false
  ): Promise<RuntimeWorktreePsResult> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const { worktrees: resolvedWorktrees, platformByRepoId } = this.visibleResolvedWorktreeSnapshot(
      await this.listResolvedWorktreeSnapshot(),
      sourceDefaultsSupported
    )
    const freshPtyLiveness = await this.refreshPtyWorktreeRecordsFromController(resolvedWorktrees)
    const repoById = new Map((this.store?.getRepos() ?? []).map((repo) => [repo.id, repo]))
    const summaries = buildRuntimeWorktreePsSummaries({
      store: this.store,
      resolvedWorktrees,
      platformByRepoId
    })

    const getSummary = createRuntimeWorktreePsSummaryLookup(
      summaries,
      buildRuntimeWorktreeSummaryPathIndex(summaries, resolvedWorktrees, platformByRepoId)
    )
    const session = this.store?.getWorkspaceSession?.()
    const countedPtyIds = new Set<string>()
    const terminalTitleEvidenceByWorktreeId = applyRuntimeWorktreePsTerminalActivity({
      freshPtyLiveness,
      countedPtyIds,
      leaves: this.leaves.values(),
      ptysById: this.ptysById,
      tabs: this.tabs,
      session,
      getPaneKey: (leaf) => this.makeRuntimePaneKey(leaf),
      paneOf: (pty) => this.paneOfPty(pty),
      getTitleDisplayClear: (ptyId) => this.getPtyTitleDisplayClear(ptyId),
      getSummary
    })
    applyRuntimeWorktreePsUnverifiableTerminals({
      countedPtyIds,
      leaves: this.leaves.values(),
      ptysById: this.ptysById,
      getLivenessVerdict: (ptyId) => this.getPtyLivenessVerdict(ptyId),
      getSummary
    })
    const { mirroredWorktreeIdByTabId, connectedPtyEvidence } =
      applyRuntimeWorktreePsSessionActivity({
        store: this.store,
        summaries,
        repoById,
        ptysById: this.ptysById,
        tabs: this.tabs,
        paneOf: (pty) => this.paneOfPty(pty),
        getTerminalHandlesForPty: (ptyId) => this.getExistingTerminalHandlesForPtyId(ptyId),
        getSummary
      })
    const rowSources = collectRuntimeWorktreeAgentSources({
      mirroredWorktreeIdByTabId,
      connectedPtyEvidence,
      hookSnapshots: this.getAgentStatusSnapshotFn?.() ?? [],
      readStructuredSummary: getStructuredAgentSessionHost()?.readStatusSummary
    })
    attachRuntimeWorktreeAgentRows({
      summaries,
      terminalTitleEvidenceByWorktreeId,
      rowSources,
      orchestrationByPaneKey: this.agentOrchestrationProjection.buildByPaneKey(),
      getSummary
    })

    const sorted = [...summaries.values()].sort(compareWorktreePs)
    // Apply per-host pagination so hosts sorting last cannot disappear behind a global cap (#18104).
    const page = buildWorktreeListingPage(
      sorted,
      limit,
      withoutHiddenHosts(this.listKnownExecutionHostIds(), runtimeHiddenHostIds(this.store))
    )
    return includeAgentWait ? attachRuntimeWorktreeAgentRowWaits(page, rowSources, this) : page
  }

  /** Match desktop visibility, including imported worktrees, through the worktree.list gate. */
  protected visibleResolvedWorktreeSnapshot(
    snapshot: ResolvedWorktreeSnapshot,
    sourceDefaultsSupported = true
  ): ResolvedWorktreeSnapshot {
    const visibilitySettings = this.store?.getSettings()
    const visibilitySourceMatchersByRepoId = this.buildRuntimeVisibilitySourceMatchersByRepoId(
      snapshot.worktrees,
      sourceDefaultsSupported,
      visibilitySettings
    )
    const hiddenRepos = runtimeHiddenRepos(this.store)
    return {
      ...snapshot,
      worktrees: snapshot.worktrees.filter(
        (worktree) =>
          !hiddenRepos.hasWorktree(worktree) &&
          this.isRuntimeWorktreeVisible(
            worktree,
            visibilitySourceMatchersByRepoId.get(worktree.repoId),
            sourceDefaultsSupported,
            visibilitySettings
          )
      )
    }
  }

  listRepos(): Repo[] {
    return this.store?.getRepos() ?? []
  }

  /** Exclude retained migration sources from client listings. */
  listVisibleRepos(): Repo[] {
    return runtimeVisibleRepos(this.store)
  }

  enrichMissingRepoGitRemoteIdentities(): void {
    if (!this.store) {
      return
    }
    enrichMissingRepoGitRemoteIdentities(this.store, {
      onChanged: () => {
        this.invalidateResolvedWorktreeCache()
        this.notifyReposChanged()
      }
    })
  }

  isWorkspaceNotificationMuted(workspaceId: string): boolean {
    const store = this.store
    return (
      !!store &&
      isWorkspaceNotificationMuted(
        { store, resolvedWorktrees: this.resolvedWorktrees.peek()?.worktrees ?? null },
        workspaceId
      )
    )
  }

  /** Admission needs only the ledger; a later chat host must reuse this store. */
  async openAgentSessionRecordStore(): Promise<AgentSessionRecordStore> {
    const { store } = await openAgentSessionRecordStoreOnce({
      stateDirectory: getProfileUserDataPath(),
      legacySessionTabIds: this.legacyStructuredSessionTabIds,
      hostId: LOCAL_EXECUTION_HOST_ID,
      logger: neverThrowingStructuredAgentSessionLogger(createStructuredAgentSessionLogger())
    })
    return store
  }

  /** Defer host creation until profile paths are final and chat is used; reuse an admission-opened record store. */
  async ensureStructuredAgentSessionHost(): Promise<void> {
    const logger = createStructuredAgentSessionLogger()
    const nameChat = createStructuredChatNamingHandler(
      structuredChatNamingDeps(
        () => this.requireStore(),
        {
          resolveWorkspace: async (workspaceId) => {
            const target = await this.resolveRuntimeFileTarget(`id:${workspaceId}`)
            return { path: target.worktree.path, executionHostId: target.executionHostId }
          },
          getAgentEnvResolvers: () => this.getCommitMessageAgentEnvironmentResolvers(),
          resolveNamingEnvironment: (agent) =>
            resolveHostStructuredAgentLaunchEnvironment(agent, this.requireStore().getSettings()),
          workerTaskTitle: (record) =>
            structuredWorkerOpenTaskTitle(this.getOrchestrationDbIfAvailable?.() ?? null, record),
          retitleOpenTab: (workspaceId, sessionId) =>
            this.refreshStructuredConversationTabTitle(workspaceId, sessionId)
        },
        logger
      )
    )
    await installStructuredAgentSessionHost({
      stateDirectory: getProfileUserDataPath(),
      legacySessionTabIds: this.legacyStructuredSessionTabIds,
      hostId: LOCAL_EXECUTION_HOST_ID,
      claimKeyId: this.agentSessionClaimSigner.keyId,
      logger,
      // Resolve plain folder workspaces as well as git worktrees.
      resolveWorkspacePath: async (workspaceId) =>
        (await this.resolveRuntimeFileTarget(`id:${workspaceId}`)).worktree.path,
      resolveClaudeCommand: (options) =>
        resolveStructuredAgentCommand('claude', this.requireStore().getSettings(), options),
      resolveCodexCommand: (options) =>
        resolveStructuredAgentCommand('codex', this.requireStore().getSettings(), options),
      resolveLaunchArgs: (agent) =>
        structuredAgentConfiguredArgs(agent, this.requireStore().getSettings()),
      // Production-only wiring prevents test runtimes from probing a real Claude CLI.
      claudeCliFlags: claudeCliFlagSupport,
      nativeChatVisuals: {
        isEnabled: () => this.requireStore().getSettings().nativeChatInlineVisuals !== false
      },
      resolveShellEnvironmentPolicy: () =>
        nativeChatShellEnvironmentPolicy(this.requireStore().getSettings()),
      resolveClaudeAuthPolicy: () =>
        claudeStructuredAuthPolicyForSettings(this.requireStore().getSettings()),
      resolveAgentFullAccess: (agent) =>
        isTuiAgent(agent) &&
        preModeChatGetsFullAccess(agent, this.requireStore().getSettings(), process.platform),
      resolveAgentLaunchEnv: (agent) =>
        isTuiAgent(agent)
          ? this.structuredAgentLaunchEnv(agent, this.requireStore().getSettings())
          : {},
      resolveAgentCommandSettings: () => this.requireStore().getSettings(),
      resolveCodexAccountKind: (home) =>
        resolveStructuredCodexAccountKind(home, this.requireStore().getSettings()),
      resolveAgentAccountHome: (agent) => this.resolveStructuredAgentAccountHome(agent),
      ...(this.prepareCodexCatalogProbeHomeFn
        ? { prepareCodexCatalogProbeHome: this.prepareCodexCatalogProbeHomeFn }
        : {}),
      onRequestFailure: (failure) => this.onStructuredRequestFailureForErrorMail(failure),
      // Structured chat has no CLI hooks; this projection drives first-work renaming.
      onSessionStatusChanged: (summary, options) => {
        this.onStructuredSessionStatusForMail(summary)
        nameChat(summary, options)
        void maybeAutoRenameWorkspaceOnFirstStructuredTurn(
          summary,
          options,
          firstWorkRenameDeps(this.requireStore(), this)
        )
      },
      ...(this.structuredAgentStatusSinkFn ? { statusSink: this.structuredAgentStatusSinkFn } : {}),
      conversationNaming: nameChat,
      onSessionTabHidden: (sessionId) => this.onStructuredSessionTabHidden(sessionId),
      assertNoTerminalWriter: (record) => this.assertStructuredChatAcquireAdmissible(record),
      attentionDelivery: createStructuredAttentionMobileDelivery({
        readNotificationSettings: () => this.requireStore().getSettings().notifications,
        readWorkspaceLabels: (scope) =>
          readStructuredAttentionWorkspaceLabels(this.requireStore(), scope),
        isWorkspaceMuted: (scope) => this.isWorkspaceNotificationMuted(scope.workspaceId),
        dispatch: (event) => this.mobileNotifications.dispatch(event),
        reconcile: (state) => this.mobileNotifications.reconcileStructuredPromptAttention(state),
        now: () => Date.now()
      }),
      // Re-read dispatch ownership each sweep; absence of a database cannot keep the worker alive.
      hasOpenDispatch: (record) =>
        structuredWorkerOwesWork(this.getOrchestrationDbIfAvailable?.() ?? null, record)
    })
  }

  /** A chat worker whose request settled failed tells the Run that dispatched it. */
  onStructuredRequestFailureForErrorMail(failure: StructuredAgentSessionRequestFailure): void {
    void escalateChatWorkerError(failure, {
      enabled: () => this.isChatWorkerErrorEscalationEnabled(),
      db: () => this.getOrchestrationDbIfAvailable(),
      notify: (handle, messageType) => this.notifyMessageArrived(handle, messageType)
    })
  }
}
