// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { resolveStructuredCodexAccountKind } from './structured-agent-account-home'
import { collectRuntimeWorktreeAgentSources } from './runtime-worktree-agent-sources'
import { OrcaRuntimeWithStartTuiIdleVisibleReadProbe } from './orca-runtime-start-tui-idle-visible-read-probe'
import { DEFAULT_WORKTREE_PS_LIMIT } from './orca-runtime-postlude'
import type { RuntimeWorktreePsResult } from '../../shared/runtime-types'
import { buildRuntimeWorktreePsSummaries } from './runtime-worktree-ps-summaries'
import { buildRuntimeWorktreeSummaryPathIndex } from './runtime-worktree-summary-paths'
import {
  applyRuntimeWorktreePsSessionActivity,
  applyRuntimeWorktreePsTerminalActivity
} from './runtime-worktree-ps-activity'
import { applyRuntimeWorktreePsUnverifiableTerminals } from './runtime-worktree-ps-unverifiable-terminals'
import { attachRuntimeWorktreeAgentRows } from './runtime-worktree-agent-rows'
import { compareWorktreePs } from './runtime-worktree-status-projection'
import type { Repo } from '../../shared/repo-types'
import { enrichMissingRepoGitRemoteIdentities } from '../repo-git-remote-identity-enrichment'
import { ensureStructuredAgentSessionHost as installStructuredAgentSessionHost } from './structured-agent-session-runtime'
import {
  createStructuredAttentionMobileDelivery,
  readStructuredAttentionWorkspaceLabels
} from './structured-agent-session-mobile-attention'
import {
  createStructuredAgentSessionLogger,
  neverThrowingStructuredAgentSessionLogger
} from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { openAgentSessionRecordStoreOnce } from './agent-session-record-store-slot'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import { maybeAutoRenameWorkspaceOnFirstStructuredTurn } from '../agent-hooks/first-work-structured-session-rename'
import { firstWorkRenameDeps } from '../agent-hooks/first-work-rename-runtime'
import { createStructuredChatNamingHandler } from '../native-chat/structured-chat-naming'
import { structuredChatNamingDeps } from './structured-chat-naming-runtime'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { buildWorktreeListingPage } from './worktree-listing-host-scope'
import { structuredWorkerOwesWork } from './structured-worker-custody'
import {
  resolvedTuiAgentArgsBypassPermissions,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { nativeChatShellEnvironmentPolicy } from '../../shared/native-chat-shell-environment'
import { claudeStructuredPermissionModeForSettings } from '../claude/claude-structured-permission-mode'
import { codexStructuredPermissionPolicyForSettings } from '../codex/codex-structured-permission-policy'
import { claudeStructuredAuthPolicyForSettings } from '../claude-accounts/claude-structured-auth-policy'
import { resolveStructuredAgentCommand } from '../native-chat/structured-agent-command-resolution'
import { structuredAgentConfiguredArgs } from '../native-chat/structured-agent-configured-args'
import { claudeCliFlagSupport } from '../claude/claude-cli-flag-support'
import {
  createNativeChatVisualsWorkspaceVerdicts,
  readNativeChatVisualsWorkspaceCatalogs
} from './native-chat-visuals-workspace-verdict'

export class OrcaRuntimeWithGetWorktreePs extends OrcaRuntimeWithStartTuiIdleVisibleReadProbe {
  async getWorktreePs(
    limit = DEFAULT_WORKTREE_PS_LIMIT,
    sourceDefaultsSupported = true
  ): Promise<RuntimeWorktreePsResult> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const resolvedWorktreeSnapshot = await this.listResolvedWorktreeSnapshot()
    const visibilitySettings = this.store?.getSettings()
    const visibilitySourceMatchersByRepoId = this.buildRuntimeVisibilitySourceMatchersByRepoId(
      resolvedWorktreeSnapshot.worktrees,
      sourceDefaultsSupported,
      visibilitySettings
    )
    const resolvedWorktrees = resolvedWorktreeSnapshot.worktrees.filter((worktree) =>
      this.isRuntimeWorktreeVisible(
        worktree,
        visibilitySourceMatchersByRepoId.get(worktree.repoId),
        sourceDefaultsSupported,
        visibilitySettings
      )
    )
    // Why: worktree.ps backs the mobile sidebar, so it must use the same
    // host-owned imported-worktree visibility gate as worktree.list/desktop.
    const freshPtyLiveness = await this.refreshPtyWorktreeRecordsFromController(resolvedWorktrees)
    const repoById = new Map((this.store?.getRepos() ?? []).map((repo) => [repo.id, repo]))
    const platformByRepoId = resolvedWorktreeSnapshot.platformByRepoId
    const summaries = buildRuntimeWorktreePsSummaries({
      store: this.store,
      resolvedWorktrees,
      platformByRepoId
    })

    const runtimeWorktreeSummaryPathIndex = buildRuntimeWorktreeSummaryPathIndex(
      summaries,
      resolvedWorktrees,
      platformByRepoId
    )
    const missingRuntimeWorktreeIds = new Set<string>()
    const session = this.store?.getWorkspaceSession?.()
    const countedPtyIds = new Set<string>()
    const workingTerminalEvidenceByWorktreeId = applyRuntimeWorktreePsTerminalActivity({
      summaries,
      pathIndex: runtimeWorktreeSummaryPathIndex,
      missingIds: missingRuntimeWorktreeIds,
      freshPtyLiveness,
      countedPtyIds,
      leaves: this.leaves.values(),
      ptysById: this.ptysById,
      tabs: this.tabs,
      session,
      getPaneKey: (leaf) => this.makeRuntimePaneKey(leaf),
      getTitleDisplayClear: (ptyId) => this.getPtyTitleDisplayClear(ptyId),
      getSummary: (summaryMap, pathIndex, missingIds, worktreeId) =>
        this.getSummaryForRuntimeWorktreeId(summaryMap, pathIndex, missingIds, worktreeId)
    })
    applyRuntimeWorktreePsUnverifiableTerminals({
      summaries,
      pathIndex: runtimeWorktreeSummaryPathIndex,
      missingIds: missingRuntimeWorktreeIds,
      countedPtyIds,
      leaves: this.leaves.values(),
      ptysById: this.ptysById,
      getLivenessVerdict: (ptyId) => this.getPtyLivenessVerdict(ptyId),
      getSummary: (summaryMap, pathIndex, missingIds, worktreeId) =>
        this.getSummaryForRuntimeWorktreeId(summaryMap, pathIndex, missingIds, worktreeId)
    })
    const { mirroredWorktreeIdByTabId, connectedPtyEvidence } =
      applyRuntimeWorktreePsSessionActivity({
        store: this.store,
        summaries,
        repoById,
        pathIndex: runtimeWorktreeSummaryPathIndex,
        missingIds: missingRuntimeWorktreeIds,
        ptysById: this.ptysById,
        tabs: this.tabs,
        getTerminalHandlesForPty: (ptyId) => this.getExistingTerminalHandlesForPtyId(ptyId),
        getSummary: (summaryMap, pathIndex, missingIds, worktreeId) =>
          this.getSummaryForRuntimeWorktreeId(summaryMap, pathIndex, missingIds, worktreeId)
      })
    attachRuntimeWorktreeAgentRows({
      summaries,
      pathIndex: runtimeWorktreeSummaryPathIndex,
      missingWorktreeIds: missingRuntimeWorktreeIds,
      workingTerminalEvidenceByWorktreeId,
      rowSources: collectRuntimeWorktreeAgentSources({
        mirroredWorktreeIdByTabId,
        connectedPtyEvidence,
        // Structured sessions are in here too: the host publishes them into the same store.
        hookSnapshots: this.getAgentStatusSnapshotFn?.() ?? []
      }),
      orchestrationByPaneKey: this.agentOrchestrationProjection.buildByPaneKey(),
      getSummary: (summaryMap, pathIndex, missingIds, worktreeId) =>
        this.getSummaryForRuntimeWorktreeId(summaryMap, pathIndex, missingIds, worktreeId)
    })

    const sorted = [...summaries.values()].sort(compareWorktreePs)
    // Why: the same cap starvation as worktree.list — a host whose rows all sort last gets no
    // page at all, which is indistinguishable from it having no workspaces (#18104).
    return buildWorktreeListingPage(sorted, limit, this.listKnownExecutionHostIds())
  }

  listRepos(): Repo[] {
    return this.store?.getRepos() ?? []
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

  /** The durable record store alone, without the chat host: launch admission needs only its
   *  ledger. A host installed later is built on this same store. */
  async openAgentSessionRecordStore(): Promise<AgentSessionRecordStore> {
    const { store } = await openAgentSessionRecordStoreOnce({
      stateDirectory: getProfileUserDataPath(),
      hostId: LOCAL_EXECUTION_HOST_ID,
      logger: neverThrowingStructuredAgentSessionLogger(createStructuredAgentSessionLogger())
    })
    return store
  }

  /**
   * Installs the structured agent-session host on first use. Lazy for the same
   * reason the orchestration DB is: the profile's user-data path is not final
   * until the app is ready, and a runtime nobody drives a chat session on never
   * builds the chat host. The record store it sits on may already be open, from
   * a launch's admission.
   */
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
          hasOpenDispatch: (record) =>
            structuredWorkerOwesWork(this.getOrchestrationDbIfAvailable?.() ?? null, record),
          retitleOpenTab: (workspaceId, sessionId) =>
            this.refreshStructuredConversationTabTitle(workspaceId, sessionId)
        },
        logger
      )
    )
    await installStructuredAgentSessionHost({
      stateDirectory: getProfileUserDataPath(),
      hostId: LOCAL_EXECUTION_HOST_ID,
      claimKeyId: this.agentSessionClaimSigner.keyId,
      // The host's local trace file (the desktop's or orcad's own), plus the console.
      logger,
      // Resolves folder workspaces as well as git worktrees, so a chat session
      // in a plain folder lands in the folder rather than failing to resolve.
      resolveWorkspacePath: async (workspaceId) =>
        (await this.resolveRuntimeFileTarget(`id:${workspaceId}`)).worktree.path,
      resolveClaudeCommand: () =>
        resolveStructuredAgentCommand('claude', this.requireStore().getSettings()),
      resolveCodexCommand: (options) =>
        resolveStructuredAgentCommand('codex', this.requireStore().getSettings(), options),
      resolveLaunchArgs: (agent) =>
        structuredAgentConfiguredArgs(agent, this.requireStore().getSettings()),
      resolveLaunchEnvOverlay: () =>
        resolveTuiAgentLaunchEnv('codex', this.requireStore().getSettings().agentDefaultEnv),
      resolveClaudeLaunchEnv: () =>
        resolveTuiAgentLaunchEnv('claude', this.requireStore().getSettings().agentDefaultEnv),
      // Wired only here, so a test runtime never runs a real `claude --version`.
      claudeCliFlags: claudeCliFlagSupport,
      nativeChatVisuals: {
        isEnabled: () => this.requireStore().getSettings().nativeChatInlineVisuals !== false,
        // Chats and their visuals are shared by every profile; each profile keeps its own catalog.
        workspaceVerdicts: createNativeChatVisualsWorkspaceVerdicts(() =>
          this.store ? readNativeChatVisualsWorkspaceCatalogs(this.store) : null
        )
      },
      resolveShellEnvironmentPolicy: () =>
        nativeChatShellEnvironmentPolicy(this.requireStore().getSettings()),
      resolveClaudeAuthPolicy: () =>
        claudeStructuredAuthPolicyForSettings(this.requireStore().getSettings()),
      // Re-read per acquisition, like the auth policy above it: the Agent Permissions setting is
      // the one copy of this fact, even when Arguments contain permission flags.
      resolveClaudePermissionMode: () =>
        claudeStructuredPermissionModeForSettings(this.requireStore().getSettings()),
      resolveCodexPermissionPolicy: () =>
        codexStructuredPermissionPolicyForSettings(this.requireStore().getSettings()),
      resolveAgentFullAccess: (agent) =>
        isTuiAgent(agent) &&
        resolvedTuiAgentArgsBypassPermissions(
          agent,
          this.requireStore().getSettings(),
          process.platform
        ),
      resolveAgentLaunchEnv: (agent) =>
        isTuiAgent(agent)
          ? resolveTuiAgentLaunchEnv(agent, this.requireStore().getSettings().agentDefaultEnv)
          : {},
      resolveAgentCommandSettings: () => this.requireStore().getSettings(),
      resolveCodexAccountKind: (home) =>
        resolveStructuredCodexAccountKind(home, this.requireStore().getSettings()),
      // Same gate and same settings as agentSession.createSupport, re-read on every acquisition.
      getClaudeManagedAccountGateSettings: () => this.requireStore().getSettings(),
      resolveAgentAccountHome: (agent) => this.resolveStructuredAgentAccountHome(agent),
      ...(this.prepareCodexCatalogProbeHomeFn
        ? { prepareCodexCatalogProbeHome: this.prepareCodexCatalogProbeHomeFn }
        : {}),
      // Structured chat has no agent CLI hooks, so this projection is what the first-work
      // workspace rename listens to instead of `agentStatus:set`.
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
      // A closed chat settles the Dispatch it was working, as a closed terminal does.
      onSessionTabHidden: (sessionId) => this.onStructuredSessionTabHidden(sessionId),
      attentionDelivery: createStructuredAttentionMobileDelivery({
        readNotificationSettings: () => this.requireStore().getSettings().notifications,
        readWorkspaceLabels: (scope) =>
          readStructuredAttentionWorkspaceLabels(this.requireStore(), scope),
        dispatch: (event) => this.mobileNotifications.dispatch(event),
        reconcile: (state) => this.mobileNotifications.reconcileStructuredPromptAttention(state),
        now: () => Date.now()
      }),
      // Read per sweep tick from the orchestration database: a worker whose dispatch is open keeps
      // its agent running. No database answers no.
      hasOpenDispatch: (record) =>
        structuredWorkerOwesWork(this.getOrchestrationDbIfAvailable?.() ?? null, record)
    })
  }
}
