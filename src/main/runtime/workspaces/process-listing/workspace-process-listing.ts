import { getRepoHostIdentityForParts } from '../../../../shared/repository/repo-host-identity'
import { createRepoRowExecutionHostLookup } from '../../../../shared/execution-host/worktree-execution-host-resolution'
import { resolveWorktreeHostRouting } from '../catalog/worktree-launch-host-repo'
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
import { openAgentSessionRecordStoreOnce } from '../../agent-session/records/agent-session-record-store-slot'
import { localAgentSessionRecordStoreLocation } from '../../agent-session/records/local-agent-session-record-store-startup-open'
import type { AgentSessionRecordStore } from '../../agent-session/records/agent-session-record-store'
import { buildWorktreeListingPage } from '../catalog/worktree-listing-host-scope'
import {
  runtimeHiddenHostIds,
  runtimeHiddenRepos,
  runtimeVisibleRepos,
  withoutHiddenHosts
} from '../catalog/runtime-visible-catalog'
import { isWorkspaceNotificationMuted } from '../../push/notifications/workspace-notification-mute'
import { WorkerAutoReleaseActivity } from '../../orchestration/terminal-authority/release/worker-auto-release-activity'

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
    void import('../../agent-session/installation/runtime-structured-agent-session-bootstrap').then(
      ({ startRuntimePullRequestWatches }) =>
        startRuntimePullRequestWatches(
          {
            legacySessionTabIds: this.legacyStructuredSessionTabIds,
            resolveRuntimeFileTarget: (selector) => this.resolveRuntimeFileTarget(selector),
            store: () => this.requireStore()
          },
          options
        )
    )
  }

  /** Defer host creation until profile paths are final and chat is used; reuse an admission-opened record store. */
  async ensureStructuredAgentSessionHost(): Promise<void> {
    const { ensureRuntimeStructuredAgentSessionHost } =
      await import('../../agent-session/installation/runtime-structured-agent-session-bootstrap')
    await ensureRuntimeStructuredAgentSessionHost({
      legacySessionTabIds: this.legacyStructuredSessionTabIds,
      claimKeyId: this.agentSessionClaimSigner.keyId,
      requireStore: () => this.requireStore(),
      resolveRuntimeFileTarget: (selector) => this.resolveRuntimeFileTarget(selector),
      getCommitMessageAgentEnvironmentResolvers: () =>
        this.getCommitMessageAgentEnvironmentResolvers(),
      getOrchestrationDbIfAvailable: () => this.getOrchestrationDbIfAvailable?.() ?? null,
      getExistingOrchestrationDb: () => this.getExistingOrchestrationDb(),
      getOrchestrationDb: () => this.getOrchestrationDb(),
      readWorkerDockSource: (source) => this._orchestrationDb?.workerDockSources.read(source),
      refreshStructuredConversationTabTitle: (workspaceId, sessionId) =>
        this.refreshStructuredConversationTabTitle(workspaceId, sessionId),
      structuredAgentCatalogDependencies: () => this.structuredAgentCatalogDependencies(),
      botStructuredSessionHostDeps: (requireStore) =>
        this.botStructuredSessionHostDeps(requireStore),
      usageLimitAutoContinueHostDeps: () => this.usageLimitAutoContinueHostDeps(),
      resolveStructuredAgentLaunchAccountHome: (record, purpose) =>
        this.resolveStructuredAgentLaunchAccountHome(record, purpose),
      prepareStructuredAgentLaunchAccountHome: (record, launchDirectory) =>
        this.prepareStructuredAgentLaunchAccountHome(record, launchDirectory),
      onStructuredRequestFailureForErrorMail: (failure) =>
        this.onStructuredRequestFailureForErrorMail(failure),
      onStructuredIdleProviderDeathForMail: (death) =>
        this.onStructuredIdleProviderDeathForMail(death),
      onStructuredUserClosedProviderForMail: (closed) =>
        this.onStructuredUserClosedProviderForMail(closed),
      notifyCrewChanges: (change) => this.crewChanges.notify(change),
      onStructuredSessionStatusForMail: (summary) => this.onStructuredSessionStatusForMail(summary),
      observeWorkerAutoReleaseChat: (summary) =>
        this.workerAutoReleaseActivity.observeChat(summary),
      firstWorkRenameRuntime: this,
      structuredAgentStatusSinkFn: this.structuredAgentStatusSinkFn,
      onStructuredSessionTabHidden: (sessionId) => this.onStructuredSessionTabHidden(sessionId),
      structuredChatMailOwed: (sessionId, from) => this.structuredChatMailOwed(sessionId, from),
      assertStructuredChatAcquireAdmissible: (record) =>
        this.assertStructuredChatAcquireAdmissible(record),
      botAttentionDeliveryDeps: () => this.botAttentionDeliveryDeps(),
      readOrchestrationForPaneKey: (paneKey) =>
        this.agentOrchestrationProjection.getForPaneKey(paneKey),
      dispatchMobileNotification: (event) => this.mobileNotifications.dispatch(event),
      reconcileStructuredPromptAttention: (state) =>
        this.mobileNotifications.reconcileStructuredPromptAttention(state),
      workerTurnStopReportDeps: this.workerTurnStopReportDeps,
      backfillBotBackgroundChats: () => this.backfillBotBackgroundChats()
    })
    // Starts watches not yet running once the host has served: a failed first start or a teardown retries here.
    this.startPullRequestWatches()
  }
}
