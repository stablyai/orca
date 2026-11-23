import { crewChatStatusChange } from '../../orchestration/crew/crew-changes'
import { getRepoHostIdentityForParts } from '../../../../shared/repository/repo-host-identity'
import { createRepoRowExecutionHostLookup } from '../../../../shared/execution-host/worktree-execution-host-resolution'
import { resolveWorktreeHostRouting } from '../catalog/worktree-launch-host-repo'
import { resolveHostStructuredAgentLaunchEnvironment } from '../../agent-session/launch/structured-agent-launch-support'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { collectRuntimeWorktreeAgentSources } from './runtime-worktree-agent-sources'
import { RuntimeChatWorkerEvents } from '../../orchestration/workers/turn-stops/chat-worker-runtime-events'

import type { RuntimeWorktreePsResult } from '../../../../shared/worktree/catalog/runtime-worktree-contracts'
import type { ResolvedWorktreeSnapshot } from '../catalog/runtime-resolved-worktree-cache'
import { buildRuntimeWorktreePsSummaries } from './runtime-worktree-ps-summaries'
import {
  buildRuntimeWorktreeSummaryPathIndex,
  createRuntimeWorktreePsSummaryLookup
} from './runtime-worktree-summary-paths'
import {
  applyRuntimeWorktreePsSessionActivity,
  applyRuntimeWorktreePsTerminalActivity
} from './runtime-worktree-ps-activity'
import { applyRuntimeWorktreePsUnverifiableTerminals } from './runtime-worktree-ps-unverifiable-terminals'
import { attachRuntimeWorktreeAgentRows } from './runtime-worktree-agent-rows'
import { attachRuntimeWorktreeAgentRowWaits } from './runtime-worktree-agent-row-waits'
import { compareWorktreePs } from './runtime-worktree-status-projection'
import type { Repo } from '../../../../shared/repository/repo-types'
import { enrichMissingRepoGitRemoteIdentities } from '../../../workspaces/catalog/repo-git-remote-identity-enrichment'
import { ensureStructuredAgentSessionHost as installStructuredAgentSessionHost } from '../../agent-session/installation/structured-agent-session-runtime'
import {
  createStructuredAttentionMobileDelivery,
  readStructuredAttentionWorkspaceLabels
} from '../../agent-session/lifecycle/structured-agent-session-mobile-attention'
import {
  createStructuredAgentSessionLogger,
  neverThrowingStructuredAgentSessionLogger
} from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { openAgentSessionRecordStoreOnce } from '../../agent-session/records/agent-session-record-store-slot'
import { localAgentSessionRecordStoreLocation } from '../../agent-session/records/local-agent-session-record-store-startup-open'
import type { AgentSessionRecordStore } from '../../agent-session/records/agent-session-record-store'
import { maybeAutoRenameWorkspaceOnFirstStructuredTurn } from '../../../agent-hooks/first-work/first-work-structured-session-rename'
import { firstWorkRenameDeps } from '../../../agent-hooks/first-work/first-work-rename-runtime'
import { createStructuredChatNamingHandler } from '../../../native-chat/structured-chat-naming'
import { structuredChatNamingDeps } from '../../agent-session/naming/structured-chat-naming-runtime'
import { getProfileUserDataPath } from '../../../orca-profiles/profile-storage-paths'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { chatWorkerTurnStopReporter } from '../../orchestration/workers/turn-stops/chat-worker-turn-stops'
import { buildWorktreeListingPage } from '../catalog/worktree-listing-host-scope'
import {
  structuredWorkerOpenTaskTitle,
  structuredWorkerOwesWork
} from '../../orchestration/terminal-authority/structured-sessions/structured-worker-custody'
import { structuredAgentSettingGates } from '../../agent-session/launch/structured-agent-setting-gates'
import { claudeCliFlagSupport } from '../../../claude/cli-capabilities/claude-cli-flag-support'
import {
  runtimeHiddenHostIds,
  runtimeHiddenRepos,
  runtimeVisibleRepos,
  withoutHiddenHosts
} from '../catalog/runtime-visible-catalog'
import { isWorkspaceNotificationMuted } from '../../push/notifications/workspace-notification-mute'
import { WorkerAutoReleaseActivity } from '../../orchestration/terminal-authority/release/worker-auto-release-activity'
import { nativeChatIdleStopMs } from '../../../../shared/native-chat/settings/native-chat-idle-stop'
import { prWatchWorkspaceSources } from '../../agent-session/lifecycle/pr-watch-workspace-sources'
import { startPRWatchRuntime } from '../../agent-session/lifecycle/pr-watch-runtime'
import { workerDockFailureSink } from '../../orchestration/dock/worker-dock-provider-failures'
import { workerDockSourceOfSession } from '../../orchestration/dock/worker-dock-source'

export abstract class OrcaRuntimeWithGetWorktreePs extends RuntimeChatWorkerEvents {
  protected readonly workerAutoReleaseActivity = new WorkerAutoReleaseActivity(
    () => this._orchestrationDb
  )

  /** The task each pane was dispatched, by pane key, as `worktree.ps` rows title it. */
  listAgentTasksByPaneKey = () => this.agentOrchestrationProjection.buildByPaneKey() ?? {}

  async getWorktreePs(
    limit = 200,
    sourceDefaultsSupported = true,
    includeAgentWait = false,
    worktreeId?: string
  ): Promise<RuntimeWorktreePsResult> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const { worktrees: resolvedWorktrees, platformByRepoId } = this.visibleResolvedWorktreeSnapshot(
      await this.listResolvedWorktreeSnapshot(),
      sourceDefaultsSupported
    )
    const freshPtyLiveness = await this.refreshPtyWorktreeRecordsFromController(resolvedWorktrees)
    const summaries = buildRuntimeWorktreePsSummaries({
      store: this.store,
      resolvedWorktrees,
      platformByRepoId,
      worktreeId
    })
    const getSummary = createRuntimeWorktreePsSummaryLookup(
      summaries,
      buildRuntimeWorktreeSummaryPathIndex(summaries, platformByRepoId)
    )
    const session = this.store?.getWorkspaceSession?.()
    const countedPtyIds = new Set<string>()
    const terminalTitleEvidenceByRow = applyRuntimeWorktreePsTerminalActivity({
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
    const { mirroredWorktreeIdByTabId, connectedPtyEvidence, savedAgentRecords } =
      applyRuntimeWorktreePsSessionActivity({
        store: this.store,
        summaries,
        repoById: new Map((this.store?.getRepos() ?? []).map((repo) => [repo.id, repo])),
        ptysById: this.ptysById,
        tabs: this.tabs,
        paneOf: (pty) => this.paneOfPty(pty),
        getTerminalHandlesForPty: (ptyId) => this.getExistingTerminalHandlesForPtyId(ptyId),
        getSummary
      })
    const rowSources = collectRuntimeWorktreeAgentSources({
      mirroredWorktreeIdByTabId,
      connectedPtyEvidence,
      hookSnapshots: this.paneAgentStatuses(undefined, savedAgentRecords),
      readStructuredSummary: getStructuredAgentSessionHost()?.readStatusSummary
    })
    attachRuntimeWorktreeAgentRows({
      summaries,
      terminalTitleEvidenceByRow,
      rowSources,
      orchestrationByPaneKey: this.agentOrchestrationProjection.buildByPaneKey(),
      getSummary,
      getSessionCustomTitle: (sessionId) => this.getSessionCustomTitle(sessionId),
      getTabCustomTitle: (tabId) => this.tabs.get(tabId)?.customTitle?.trim() || null,
      conversationName: this.orchestrationSenderNames.agentRowNamer(),
      agentList: this.readAgentListPublication()
    })

    // Apply per-host pagination so hosts sorting last cannot disappear behind a global cap (#18104).
    const page = buildWorktreeListingPage(
      [...summaries.values()].sort(compareWorktreePs),
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
    const sourceMatchersByRepoId = this.buildRuntimeVisibilitySourceMatchersByRepoId(
      snapshot.worktrees,
      sourceDefaultsSupported,
      visibilitySettings
    )
    const hiddenRepos = runtimeHiddenRepos(this.store)
    const repos = this.store?.getRepos() ?? []
    const repoOwners = createRepoRowExecutionHostLookup(repos)
    return {
      ...snapshot,
      worktrees: snapshot.worktrees.filter((worktree) => {
        const owner = resolveWorktreeHostRouting(repos, worktree, repoOwners)
        if (owner.kind === 'ambiguous' || hiddenRepos.hasWorktree(worktree)) {
          return false
        }
        return this.isRuntimeWorktreeVisible(
          worktree,
          owner.kind === 'resolved'
            ? sourceMatchersByRepoId.get(getRepoHostIdentityForParts(worktree.repoId, owner.hostId))
            : undefined,
          sourceDefaultsSupported,
          visibilitySettings,
          repoOwners
        )
      })
    }
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
    const resolvedWorktrees = this.resolvedWorktrees.peek()?.worktrees ?? null
    return !!store && isWorkspaceNotificationMuted({ store, resolvedWorktrees }, workspaceId)
  }

  /** Admission needs only the ledger; a later chat host must reuse this store. */
  async openAgentSessionRecordStore(): Promise<AgentSessionRecordStore> {
    const { store } = await openAgentSessionRecordStoreOnce(
      localAgentSessionRecordStoreLocation(this.legacyStructuredSessionTabIds)
    )
    return store
  }

  /** CI-line watches run on every host once it serves (`admit`), whether or not a chat was ever opened. */
  startPullRequestWatches(options: { admit?: boolean } = {}): void {
    void startPRWatchRuntime(
      {
        stateDirectory: getProfileUserDataPath(),
        legacySessionTabIds: this.legacyStructuredSessionTabIds,
        hostId: LOCAL_EXECUTION_HOST_ID,
        logger: neverThrowingStructuredAgentSessionLogger(createStructuredAgentSessionLogger()),
        ...prWatchWorkspaceSources({
          resolveRuntimeFileTarget: (selector) => this.resolveRuntimeFileTarget(selector),
          store: () => this.requireStore()
        })
      },
      options
    )
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
    const { stateDirectory, ...catalogDeps } = this.structuredAgentCatalogDependencies()
    await installStructuredAgentSessionHost({
      stateDirectory,
      legacySessionTabIds: this.legacyStructuredSessionTabIds,
      hostId: LOCAL_EXECUTION_HOST_ID,
      claimKeyId: this.agentSessionClaimSigner.keyId,
      logger,
      ...catalogDeps,
      ...this.botStructuredSessionHostDeps(() => this.requireStore()),
      claudeCliFlags: claudeCliFlagSupport,
      usageLimitAutoContinue: this.usageLimitAutoContinueHostDeps(),
      idleSweep: { idleMs: () => nativeChatIdleStopMs(this.requireStore().getSettings()) },
      nativeChatVisuals: {
        isEnabled: () => this.requireStore().getSettings().nativeChatInlineVisuals !== false
      },
      ...structuredAgentSettingGates(() => this.requireStore().getSettings()),
      launchAccountHome: (record, purpose) =>
        this.resolveStructuredAgentLaunchAccountHome(record, purpose),
      prepareLaunchAccountHome: (record, launchDirectory) =>
        this.prepareStructuredAgentLaunchAccountHome(record, launchDirectory),
      onRequestFailure: (failure) => this.onStructuredRequestFailureForErrorMail(failure),
      onIdleProviderDeath: (death) => this.onStructuredIdleProviderDeathForMail(death),
      readWorkerDockPresence: (sessionId) =>
        this._orchestrationDb?.workerDockSources.read(workerDockSourceOfSession(sessionId)),
      // Structured chat has no CLI hooks; this projection drives first-work renaming.
      onSessionStatusChanged: (summary, options) => {
        this.crewChanges.notify(crewChatStatusChange(summary.sessionId))
        this.onStructuredSessionStatusForMail(summary)
        this.workerAutoReleaseActivity.observeChat(summary)
        nameChat(summary, options)
        void maybeAutoRenameWorkspaceOnFirstStructuredTurn(
          summary,
          options,
          firstWorkRenameDeps(this.requireStore(), this)
        )
      },
      statusSink: workerDockFailureSink(this.structuredAgentStatusSinkFn, this),
      conversationNaming: nameChat,
      onSessionTabHidden: (sessionId) => this.onStructuredSessionTabHidden(sessionId),
      queuedAgentMessageOwed: (sessionId, from) => this.structuredChatMailOwed(sessionId, from),
      assertNoTerminalWriter: (record) => this.assertStructuredChatAcquireAdmissible(record),
      attentionDelivery: createStructuredAttentionMobileDelivery({
        readNotificationSettings: () => this.requireStore().getSettings().notifications,
        readWorkspaceLabels: (scope) =>
          readStructuredAttentionWorkspaceLabels(this.requireStore(), scope),
        ...this.botAttentionDeliveryDeps(),
        // The same contexts the session's chat row carries.
        readOrchestration: (paneKey) => this.agentOrchestrationProjection.getForPaneKey(paneKey),
        dispatch: (event) => this.mobileNotifications.dispatch(event),
        reconcile: (state) => this.mobileNotifications.reconcileStructuredPromptAttention(state)
      }),
      createTurnAttention: () =>
        chatWorkerTurnStopReporter({
          ...this.workerTurnStopReportDeps,
          openExistingDb: () => this.getExistingOrchestrationDb()
        }),
      // Re-read dispatch ownership each sweep; absence of a database cannot keep the worker alive.
      hasOpenDispatch: (record) =>
        structuredWorkerOwesWork(this.getOrchestrationDbIfAvailable?.() ?? null, record)
    }).then(() => this.backfillBotBackgroundChats())
    // Starts watches not yet running once the host has served: a failed first start or a teardown retries here.
    this.startPullRequestWatches()
  }
}
