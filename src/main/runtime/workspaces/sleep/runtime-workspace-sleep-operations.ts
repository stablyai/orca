import { OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce } from '../../session-tabs/structured-session-tab-restoration'
import type { RuntimeWorktreeTerminalSleepResult } from '../../../../shared/runtime-terminal-contracts'
import type {
  WorkspaceSleepNotice,
  WorkspaceSleepOutcome,
  WorkspaceSleepRequest
} from '../../../../shared/workspace-sleep'
import { WorkspaceSleepCoordinator } from './workspace-sleep-runtime'
import { dropStrandedSleepRecord } from '../../terminal/stop/worktree-sleep-resume-records'
import type { RestoredPane } from '../../terminal/recovery/restored-pane-start'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { EphemeralVmRuntimeRecord } from '../../../../shared/ephemeral-vm-runtimes'
import { WorkspaceLifecycleQueue } from '../lifecycle/workspace-lifecycle-queue'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../shared/sidebar-inputs-switch'
export abstract class RuntimeWorkspaceSleepOperations extends OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce {
  // Switch point: only a build where main produces the sidebar's inputs queues lifecycle commands.
  readonly workspaceLifecycle = ORCA_SIDEBAR_INPUTS_IS_MAIN ? new WorkspaceLifecycleQueue() : null

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

  /** Opening a workspace wakes its recipe VM, if this host holds one; resolves with the VM's record. */
  wakeWorkspaceVm(worktreeId: string): Promise<EphemeralVmRuntimeRecord | null> {
    return this.workspaceSleep.wakeVm(worktreeId)
  }

  /** The window opened a slept pane; main resumes it and the window attaches. */
  resumeSleptPane(pane: RestoredPane, automatic?: boolean): Promise<boolean> {
    return this.workspaceSleep.resumePane(pane, automatic)
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
