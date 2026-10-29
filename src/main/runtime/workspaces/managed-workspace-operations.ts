import type { OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree } from '../terminal/launch/terminal-workspace-scope'
import { OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce } from '../session-tabs/structured-session-tab-restoration'
import { DEFAULT_WORKTREE_LIST_LIMIT } from '../orca-runtime-postlude'
import type {
  RuntimeWorktreeListResult,
  RuntimeWorktreeTerminalSleepResult
} from '../../../shared/runtime-types'
import type { DetectedWorktreeListResult, Worktree } from '../../../shared/worktree/types'
import type { Repo } from '../../../shared/repo-types'
import { stopMissingWorktreeTerminals } from '../missing-worktree-terminal-reconciliation'
import type { WorktreeVisibilitySourceMatcher } from '../../../shared/worktree/visibility-sources'
import type { RuntimeStore } from '../runtime-store-contract'
import { getWorkspaceAttachments } from '../../../shared/workspace-attachments'
import type { TerminalWorkspaceLaunchScope } from '../runtime-legacy-worker-terminal-recovery-types'
import type {
  WorkspacePortHostKillRequest,
  WorkspacePortHostScanResult,
  WorkspacePortKillRequest,
  WorkspacePortKillResult,
  WorkspacePortProbe,
  WorkspacePortScanResult
} from '../../../shared/workspace-ports'
import {
  filterWorkspacePortProbes,
  killWorkspacePort,
  scanWorkspacePortProbes
} from '../../ports/workspace-port-ownership'
import {
  killWorkspacePortOnExecutionHost,
  scanWorkspacePortsOnExecutionHost,
  type WorkspacePortExecutionHostDeps
} from '../../ports/workspace-port-execution-host'
import { resolveWorktreeHostRouting } from '../worktree-launch-host-repo'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type {
  WorkspaceSleepNotice,
  WorkspaceSleepOutcome,
  WorkspaceSleepRequest
} from '../../../shared/workspace-sleep'
import { WorkspaceSleepCoordinator } from './workspace-sleep-runtime'
import { dropStrandedSleepRecord } from '../terminal/stop/worktree-sleep-resume-records'
import type { RestoredPane } from '../terminal/recovery/restored-pane-start'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

import { WorkspaceLifecycleQueue } from './workspace-lifecycle-queue'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'

export abstract class OrcaRuntimeWithListManagedWorktrees extends OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce {
  protected abstract resolveTerminalWorkspaceLaunchTarget(
    ...args: Parameters<
      OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree['resolveTerminalWorkspaceLaunchTarget']
    >
  ): ReturnType<
    OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree['resolveTerminalWorkspaceLaunchTarget']
  >

  // Switch point: only a build where main produces the sidebar's inputs queues lifecycle commands.
  readonly workspaceLifecycle = ORCA_SIDEBAR_INPUTS_IS_MAIN ? new WorkspaceLifecycleQueue() : null

  listManagedWorktrees(
    repoSelector?: string,
    limit = DEFAULT_WORKTREE_LIST_LIMIT,
    sourceDefaultsSupported = true
  ): Promise<RuntimeWorktreeListResult> {
    return this.managedWorktreeQueries.list(repoSelector, limit, sourceDefaultsSupported)
  }

  listRetiredWorktreeNames(repoSelector: string) {
    return this.managedWorktreeQueries.listRetiredNames(repoSelector)
  }

  async listDetectedManagedWorktrees(
    repoSelector: string,
    connectionId?: string | null,
    sourceDefaultsSupported = true
  ): Promise<DetectedWorktreeListResult> {
    return this.listDetectedWorktreesForResolvedRepo(
      await this.resolveRepoSelectorForConnection(repoSelector, connectionId),
      sourceDefaultsSupported
    )
  }

  protected listDetectedWorktreesForResolvedRepo(
    repo: Repo,
    sourceDefaultsSupported = true
  ): Promise<DetectedWorktreeListResult> {
    return this.managedWorktreeQueries.listDetected(repo, sourceDefaultsSupported)
  }

  async teardownMissingManagedWorktreeTerminals(
    repoSelector: string,
    knownWorktreeIds: readonly string[],
    connectionId?: string | null
  ): Promise<{ stoppedWorktreeIds: string[] }> {
    const repo = await this.resolveRepoSelectorForConnection(repoSelector, connectionId)
    // Stop PTYs against fresh host evidence: cached scans can miss removed Git registrations and strand processes after renderer purge.
    this.invalidateWorktreeScanCacheForRepo(repo.id)
    // Reuse the resolved repo; duplicate ids across hosts could make a second id lookup ambiguous and lose the sweep.
    const detected = await this.listDetectedWorktreesForResolvedRepo(repo)
    if (!detected.authoritative) {
      return { stoppedWorktreeIds: [] }
    }
    return stopMissingWorktreeTerminals(
      repo,
      knownWorktreeIds,
      detected.worktrees.map((worktree) => worktree.id),
      {
        runtime: this,
        getLocalProvider: () => this.getLocalProvider(),
        onPtyStopped: this.onPtyStopped ?? undefined
      }
    )
  }

  protected resolveRepoSelectorForConnection(
    repoSelector: string,
    connectionId?: string | null
  ): Promise<Repo> {
    return this.managedWorktreeQueries.resolveRepoForConnection(repoSelector, connectionId)
  }

  protected isRuntimeWorktreeVisible(
    worktree: Worktree,
    worktreeVisibilitySourceMatcher?: WorktreeVisibilitySourceMatcher,
    sourceDefaultsSupported = true,
    providedSettings?: ReturnType<RuntimeStore['getSettings']>
  ): boolean {
    return this.managedWorktreeQueries.isVisible(
      worktree,
      worktreeVisibilitySourceMatcher,
      sourceDefaultsSupported,
      providedSettings
    )
  }

  protected buildRuntimeVisibilitySourceMatchersByRepoId(
    worktrees: readonly Worktree[],
    sourceDefaultsSupported = true,
    providedSettings?: ReturnType<RuntimeStore['getSettings']>
  ): Map<string, WorktreeVisibilitySourceMatcher> {
    return this.managedWorktreeQueries.buildVisibilityMatchers(
      worktrees,
      sourceDefaultsSupported,
      providedSettings
    )
  }

  async showManagedWorktree(worktreeSelector: string) {
    const worktree = await this.resolveWorkspaceSelector(worktreeSelector)
    return { ...worktree, linkedItems: getWorkspaceAttachments(worktree) }
  }

  /** Resolve a git record, refusing floating workspaces; use launch scope when only id/path is needed. */
  async showManagedTerminalWorkspace(worktreeSelector: string) {
    const target = await this.resolveTerminalWorkspaceLaunchTarget(worktreeSelector)
    if (!target.managedWorktree) {
      throw new Error('selector_not_found')
    }
    return target.managedWorktree
  }

  /** Resolve id/path uniformly for git, folder and floating workspaces; requiring a git record would reject floating targets. */
  async showTerminalWorkspaceLaunchScope(
    worktreeSelector: string
  ): Promise<TerminalWorkspaceLaunchScope> {
    return await this.resolveTerminalWorkspaceLaunchScope(worktreeSelector)
  }

  async scanWorkspacePorts(repoId?: string): Promise<WorkspacePortScanResult> {
    return scanWorkspacePortProbes(await this.getWorkspacePortProbes(repoId))
  }

  async killWorkspacePort(args: WorkspacePortKillRequest): Promise<WorkspacePortKillResult> {
    return killWorkspacePort(await this.getWorkspacePortProbes(args.repoId), args)
  }

  // Why the workspace, not a client-named host: this server resolves where the workspace runs.
  async scanWorkspacePortsOnHost(worktreeSelector: string): Promise<WorkspacePortHostScanResult> {
    const { executionHostId } = await this.resolveRuntimeFileTarget(worktreeSelector)
    return scanWorkspacePortsOnExecutionHost(executionHostId, this.getWorkspacePortHostDeps())
  }

  async killWorkspacePortOnHost(
    args: WorkspacePortHostKillRequest
  ): Promise<WorkspacePortKillResult> {
    const { executionHostId } = await this.resolveRuntimeFileTarget(args.worktree)
    return killWorkspacePortOnExecutionHost(executionHostId, args, this.getWorkspacePortHostDeps())
  }

  protected getWorkspacePortHostDeps(): WorkspacePortExecutionHostDeps {
    return {
      getLocalProbes: () => this.getWorkspacePortProbes()
    }
  }

  // Authorize RPC port probes from host-owned workspace paths, never client-supplied paths.
  protected async getWorkspacePortProbes(repoId?: string): Promise<WorkspacePortProbe[]> {
    const repos = this.requireStore().getRepos()
    return filterWorkspacePortProbes(
      (await this.listResolvedWorktrees()).map((worktree) => {
        // Resolve executionHostId too: remote SSH paths must never authorize local listeners.
        const routing = resolveWorktreeHostRouting(repos, worktree)
        return {
          id: worktree.id,
          repoId: worktree.repoId,
          displayName: worktree.displayName,
          path: worktree.git.path,
          runsHere:
            routing.kind === 'unowned' ||
            (routing.kind === 'resolved' && routing.hostId === LOCAL_EXECUTION_HOST_ID)
        }
      }),
      repoId
    )
  }

  abstract sleepTerminalsForWorktree(
    worktreeSelector: string
  ): Promise<RuntimeWorktreeTerminalSleepResult>

  private workspaceSleepCoordinator: WorkspaceSleepCoordinator | null = null

  private get workspaceSleep(): WorkspaceSleepCoordinator {
    this.workspaceSleepCoordinator ??= new WorkspaceSleepCoordinator(this)
    return this.workspaceSleepCoordinator
  }

  /** Sleeps workspaces on their own hosts, each through its lifecycle queue; the window follows. */
  sleepWorkspaces(request: WorkspaceSleepRequest): Promise<WorkspaceSleepOutcome[]> {
    return this.workspaceSleep.sleep(request)
  }

  /** The window or a phone opened the workspace: a sleep still running leaves its VM up. */
  noteWorkspaceReopened(worktreeId: string): void {
    this.workspaceSleep.noteReopened(worktreeId)
  }

  /** The wake records this host keeps for one of its workspaces. */
  wakeRecordsForWorktree(worktreeId: string): SleepingAgentSessionRecord[] {
    const session = this.store?.getWorkspaceSession?.(
      this.getWorkspaceSessionHostIdForWorktree(worktreeId)
    )
    return Object.values(session?.sleepingAgentSessionsByPaneKey ?? {}).filter(
      (record) => record.worktreeId === worktreeId
    )
  }

  /** `worktree.sleep` from a phone or the CLI: this host's own workspace, its chats included. */
  async sleepManagedWorktree(
    worktreeSelector: string,
    opts: { replyOnAcceptance?: boolean; markChatsAsleep?: boolean } = {}
  ): Promise<{ worktreeId: string } & Partial<WorkspaceSleepOutcome>> {
    const worktree = await this.resolveWorkspaceSelector(worktreeSelector)
    return this.workspaceSleep.sleepOwnWorktree(worktree.id, opts)
  }

  /** A phone's wake, queued: it waits out a sleep still running, and a delete cancels it. Never rejects. */
  protected queueSleepingAgentWake(worktreeId: string): Promise<void> {
    return this.workspaceSleep
      .wake(worktreeId)
      .catch((error: unknown) => console.warn('[runtime] sleeping agent wake failed', error))
  }

  /** The window opened a slept pane; main resumes it and the window attaches. */
  resumeSleptPane(pane: RestoredPane): Promise<boolean> {
    return this.workspaceSleep.resumePane(pane)
  }

  /** The window reopened a slept agent whose tab is gone in a fresh tab; this record is spent. */
  async retireStrandedSleepRecord(worktreeId: string, paneKey: string): Promise<void> {
    await this.commitWorkspaceSessionEdit(
      this.getWorkspaceSessionHostIdForWorktree(worktreeId),
      (session) => dropStrandedSleepRecord(session, worktreeId, paneKey)
    )
  }

  wakeWindowHibernatedAgents(worktreeId: string): void {
    this.notifier?.resumeSleepingAgents?.(worktreeId)
  }

  notifyWorkspaceSleep(notice: WorkspaceSleepNotice): void {
    this.notifier?.workspaceSleepChanged?.(notice)
  }
}
