// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
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
import { resolveWorktreeAgentConversationNames } from './runtime-worktree-agent-conversation-name'
import { attachRuntimeWorktreeAgentRows } from './runtime-worktree-agent-rows'
import { compareWorktreePs } from './runtime-worktree-status-projection'
import type { Repo } from '../../shared/repo-types'
import { enrichMissingRepoGitRemoteIdentities } from '../repo-git-remote-identity-enrichment'
import { ensureStructuredAgentSessionHost as installStructuredAgentSessionHost } from './structured-agent-session-runtime'
import { maybeAutoRenameWorkspaceOnFirstStructuredTurn } from '../agent-hooks/first-work-structured-session-rename'
import { firstWorkRenameDeps } from '../agent-hooks/first-work-rename-runtime'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { buildWorktreeListingPage } from './worktree-listing-host-scope'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import { nativeChatShellEnvironmentPolicy } from '../../shared/native-chat-shell-environment'
import { claudeStructuredPermissionModeForSettings } from '../claude/claude-structured-permission-mode'
import { codexStructuredPermissionPolicyForSettings } from '../codex/codex-structured-permission-policy'
import { claudeStructuredAuthPolicyForSettings } from '../claude-accounts/claude-structured-auth-policy'

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
    const workingTerminalEvidenceByWorktreeId = applyRuntimeWorktreePsTerminalActivity({
      summaries,
      pathIndex: runtimeWorktreeSummaryPathIndex,
      missingIds: missingRuntimeWorktreeIds,
      freshPtyLiveness,
      leaves: this.leaves.values(),
      ptysById: this.ptysById,
      tabs: this.tabs,
      session,
      getPaneKey: (leaf) => this.makeRuntimePaneKey(leaf),
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
    const rowSources = collectRuntimeWorktreeAgentSources({
      mirroredWorktreeIdByTabId,
      connectedPtyEvidence,
      // Structured sessions are in here too: the host publishes them into the same store.
      hookSnapshots: this.getAgentStatusSnapshotFn?.() ?? []
    })
    const orchestrationByPaneKey = this.agentOrchestrationProjection.buildByPaneKey()
    attachRuntimeWorktreeAgentRows({
      summaries,
      pathIndex: runtimeWorktreeSummaryPathIndex,
      missingWorktreeIds: missingRuntimeWorktreeIds,
      workingTerminalEvidenceByWorktreeId,
      rowSources,
      orchestrationByPaneKey,
      conversationNameByPaneKey: resolveWorktreeAgentConversationNames({
        sources: rowSources.values(),
        tabsByWorktree: session?.tabsByWorktree,
        unifiedTabs: session?.unifiedTabs,
        terminalLayoutsByTabId: session?.terminalLayoutsByTabId,
        generatedTitlesEnabled: visibilitySettings?.tabAutoGenerateTitle === true,
        orchestrationByPaneKey
      }),
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

  /**
   * Installs the structured agent-session host on first use. Lazy for the same
   * reason the orchestration DB is: the profile's user-data path is not final
   * until the app is ready, and a runtime nobody drives a chat session on
   * should never open the record store.
   */
  async ensureStructuredAgentSessionHost(): Promise<void> {
    await installStructuredAgentSessionHost({
      stateDirectory: getProfileUserDataPath(),
      hostId: LOCAL_EXECUTION_HOST_ID,
      claimKeyId: this.agentSessionClaimSigner.keyId,
      // Resolves folder workspaces as well as git worktrees, so a chat session
      // in a plain folder lands in the folder rather than failing to resolve.
      resolveWorkspacePath: async (workspaceId) =>
        (await this.resolveRuntimeFileTarget(`id:${workspaceId}`)).worktree.path,
      resolveLaunchEnvOverlay: () =>
        resolveTuiAgentLaunchEnv('codex', this.requireStore().getSettings().agentDefaultEnv),
      resolveClaudeLaunchEnv: () =>
        resolveTuiAgentLaunchEnv('claude', this.requireStore().getSettings().agentDefaultEnv),
      resolveShellEnvironmentPolicy: () =>
        nativeChatShellEnvironmentPolicy(this.requireStore().getSettings()),
      resolveClaudeAuthPolicy: () =>
        claudeStructuredAuthPolicyForSettings(this.requireStore().getSettings()),
      // Re-read per acquisition, like the auth policy above it: the Agent Permissions setting is
      // the one copy of this fact, and the configured CLI arguments never reach a structured launch.
      resolveClaudePermissionMode: () =>
        claudeStructuredPermissionModeForSettings(this.requireStore().getSettings()),
      resolveCodexPermissionPolicy: () =>
        codexStructuredPermissionPolicyForSettings(this.requireStore().getSettings()),
      // Same gate and same settings as agentSession.createSupport, re-read on every acquisition.
      getClaudeManagedAccountGateSettings: () => this.requireStore().getSettings(),
      resolveAgentAccountHome: (agent) => this.resolveStructuredAgentAccountHome(agent),
      // Structured chat has no agent CLI hooks, so this projection is what the first-work
      // workspace rename listens to instead of `agentStatus:set`.
      onSessionStatusChanged: (summary, options) => {
        void maybeAutoRenameWorkspaceOnFirstStructuredTurn(
          summary,
          options,
          firstWorkRenameDeps(this.requireStore(), this)
        )
      },
      ...(this.structuredAgentStatusSinkFn ? { statusSink: this.structuredAgentStatusSinkFn } : {})
    })
  }
}
