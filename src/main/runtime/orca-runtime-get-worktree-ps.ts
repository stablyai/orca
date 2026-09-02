// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithStructuredAgentSessionRecoverTuiOwner } from './orca-runtime-structured-agent-session-recover-tui-owner'
import { DEFAULT_WORKTREE_PS_LIMIT } from './orca-runtime-postlude'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import { buildRuntimeWorktreePsSummaries } from './runtime-worktree-ps-summaries'
import { buildRuntimeWorktreeSummaryPathIndex } from './runtime-worktree-summary-paths'
import {
  applyRuntimeWorktreePsSessionActivity,
  applyRuntimeWorktreePsTerminalActivity
} from './runtime-worktree-ps-activity'
import { attachRuntimeWorktreeAgentRows } from './runtime-worktree-agent-rows'
import { compareWorktreePs } from './runtime-worktree-status-projection'
import type { Repo } from '../../shared/repo-types'
import { enrichMissingRepoGitRemoteIdentities } from '../repo-git-remote-identity-enrichment'
import { ensureStructuredAgentSessionHost as installStructuredAgentSessionHost } from './structured-agent-session-runtime'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import { resolveCodexStructuredAppServerArgs } from '../codex/codex-structured-app-server-args'
import type { StructuredAgentSessionHandoffTransport } from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'
import { hostname } from 'node:os'
import { probeAgentSessionProcessIdentity } from './agent-session-process-identity-probe'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'

export class OrcaRuntimeWithGetWorktreePs extends OrcaRuntimeWithStructuredAgentSessionRecoverTuiOwner {
  async getWorktreePs(
    limit = DEFAULT_WORKTREE_PS_LIMIT,
    sourceDefaultsSupported = true
  ): Promise<{
    worktrees: RuntimeWorktreePsSummary[]
    totalCount: number
    truncated: boolean
  }> {
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
        getSummary: (summaryMap, pathIndex, missingIds, worktreeId) =>
          this.getSummaryForRuntimeWorktreeId(summaryMap, pathIndex, missingIds, worktreeId)
      })
    attachRuntimeWorktreeAgentRows({
      summaries,
      pathIndex: runtimeWorktreeSummaryPathIndex,
      missingWorktreeIds: missingRuntimeWorktreeIds,
      mirroredWorktreeIdByTabId,
      connectedPtyEvidence,
      workingTerminalEvidenceByWorktreeId,
      retainedSnapshots: this.agentRows.values(),
      hookSnapshots: this.getAgentStatusSnapshotFn?.() ?? [],
      orchestrationByPaneKey: this.agentOrchestrationProjection.buildByPaneKey(),
      getSummary: (summaryMap, pathIndex, missingIds, worktreeId) =>
        this.getSummaryForRuntimeWorktreeId(summaryMap, pathIndex, missingIds, worktreeId)
    })

    const sorted = [...summaries.values()].sort(compareWorktreePs)
    return {
      worktrees: sorted.slice(0, limit),
      totalCount: sorted.length,
      truncated: sorted.length > limit
    }
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
      resolveLaunchArgs: () => this.resolveConfiguredCodexStructuredArgs(),
      resolveLaunchEnvOverlay: () =>
        resolveTuiAgentLaunchEnv('codex', this.requireStore().getSettings().agentDefaultEnv),
      handoffTransport: this.createStructuredAgentSessionHandoffTransport()
    })
  }

  protected resolveConfiguredCodexStructuredArgs(): string[] {
    const settings = this.requireStore().getSettings()
    const shell = resolveLocalWindowsAgentStartupShell({
      platform: process.platform,
      isRemote: false,
      terminalWindowsShell: settings.terminalWindowsShell
    })
    return resolveCodexStructuredAppServerArgs(
      resolveTuiAgentLaunchArgs('codex', settings.agentDefaultArgs),
      shell ?? 'posix'
    )
  }

  protected createStructuredAgentSessionHandoffTransport(): StructuredAgentSessionHandoffTransport {
    return {
      hostLabel: hostname(),
      launchTui: this.createStructuredAgentSessionLaunchTuiCallback(),
      waitForTuiExit: async (owner) => {
        await this.waitForStructuredTuiOwnerExit(owner)
        return owner.transcriptPath ? { transcriptPath: owner.transcriptPath } : {}
      },
      waitForTuiIdleOrExit: async (owner, signal) => {
        return this.waitForStructuredTuiIdleOrExit(owner, signal)
      },
      reproveTuiOwner: this.createStructuredAgentSessionReproveTuiOwnerCallback(),
      recoverTuiOwner: this.createStructuredAgentSessionRecoverTuiOwnerCallback(),
      probeRecoveredOwner: async (record) => {
        const identity = record.lease.ownerProcess
        if (!identity) {
          return 'dead'
        }
        const proof = await probeAgentSessionProcessIdentity({ identity })
        if (proof.outcome === 'identity-matched' && proof.matchedOn.length > 0) {
          return 'live'
        }
        if (proof.outcome === 'pid-absent' || proof.outcome === 'identity-mismatch') {
          return 'dead'
        }
        return 'unknown'
      },
      stopRecoveredOwner: (record) => this.stopStructuredSessionProcess(record),
      tuiStatus: (owner) => this.structuredTuiStatus(owner),
      closeTuiOwner: (owner) => this.closeStructuredTuiOwner(owner),
      revealNativeSession: async ({ workspaceId, sessionId, agent = 'codex', adoptedTerminal }) => {
        if (adoptedTerminal || agent !== 'codex') {
          return
        }
        await this.publishStructuredAgentSessionTab({
          workspaceId,
          sessionId,
          agent,
          activate: false
        })
        this.notifier?.focusEditorTab?.(structuredAgentSessionTabId(sessionId), workspaceId)
      },
      stopFailedTuiLaunch: async (owner) => void (await this.closeStructuredTuiOwner(owner))
    }
  }
}
