import { OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce } from '../../session-tabs/structured-session-tab-restoration'
import type { RuntimeWorktreeTerminalSleepResult } from '../../../../shared/runtime-terminal-contracts'
import type {
  WorkspaceSleepNotice,
  WorkspaceSleepOutcome,
  WorkspaceSleepRequest
} from '../../../../shared/workspace-sleep'
import { WorkspaceSleepCoordinator } from './workspace-sleep-runtime'
import type { RecipeVmOpening, RecipeVmState } from './recipe-vm-operations'
import { dropStrandedSleepRecord } from '../../terminal/stop/worktree-sleep-resume-records'
import type { RestoredPane } from '../../terminal/recovery/restored-pane-start'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { EphemeralVmRuntimeRecord } from '../../../../shared/ephemeral-vm-runtimes'
import { WorkspaceLifecycleQueue } from '../lifecycle/workspace-lifecycle-queue'
import {
  deleteLostContact,
  runWorkspaceLifecycleCommand,
  workspaceLifecycleKey
} from '../lifecycle/workspace-lifecycle-commands'
import { getRuntimeWorktreeRemovalOptionsKey } from '../catalog/runtime-worktree-selection'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../shared/sidebar-inputs-switch'
import type {
  RecipeWorkspaceRemoval,
  RecipeWorkspaceRemoveParams
} from '../../../ephemeral-vm/workspace-removal'
import type { RecipeEnvironmentDescription } from '../../../../shared/recipe-host-removal'
/** Desktop-only wiring: removal of a workspace whose recipe environment this host provisioned. */
export type RecipeWorkspaceRemovalHooks = {
  owns: (params: RecipeWorkspaceRemoveParams) => boolean
  remove: (params: RecipeWorkspaceRemoveParams) => Promise<RecipeWorkspaceRemoval>
  describe: (hostId: string) => ReadonlyMap<string, RecipeEnvironmentDescription>
}

export abstract class RuntimeWorkspaceSleepOperations extends OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce {
  // Switch point: only a build where main produces the sidebar's inputs queues lifecycle commands.
  readonly workspaceLifecycle = ORCA_SIDEBAR_INPUTS_IS_MAIN ? new WorkspaceLifecycleQueue() : null
  private recipeWorkspaceRemoval: RecipeWorkspaceRemovalHooks | null = null

  setRecipeWorkspaceRemoval(hooks: RecipeWorkspaceRemovalHooks): void {
    this.recipeWorkspaceRemoval = hooks
  }

  /** Throws when several recipe records claim the workspace, so nothing is destroyed on a guess. */
  ownsRecipeWorkspaceRemoval(params: RecipeWorkspaceRemoveParams): boolean {
    return this.recipeWorkspaceRemoval?.owns(params) ?? false
  }

  removeRecipeWorkspace(params: RecipeWorkspaceRemoveParams): Promise<RecipeWorkspaceRemoval> {
    if (!this.recipeWorkspaceRemoval) {
      throw new Error('This Orca host cannot remove recipe workspaces.')
    }
    return this.recipeWorkspaceRemoval.remove(params)
  }

  /** The recipe environments a phone's delete sheet names, by workspace id, for one host. */
  describeRecipeWorkspaceEnvironments(
    hostId: string
  ): ReadonlyMap<string, RecipeEnvironmentDescription> {
    return this.recipeWorkspaceRemoval?.describe(hostId) ?? new Map()
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

  /** Opening a workspace wakes its recipe VM, if this host holds one; resolves with the VM's record. */
  wakeWorkspaceVm(worktreeId: string): Promise<EphemeralVmRuntimeRecord | null> {
    return this.workspaceSleep.wakeVm(worktreeId)
  }

  /** Removes a workspace whose recipe VM this host provisioned. It is a lifecycle delete, so it
   *  cancels queued sleeps and waits for a running one; `destroyVm` then orders the VM's destroy
   *  behind any wake or suspend still running. */
  removeRecipeWorkspaceVm<T>(
    worktreeId: string,
    hostId: string,
    options: { force: boolean; runHooks: boolean; allowFailedArchiveHook: boolean },
    remove: (destroyVm: <D>(destroy: () => Promise<D>) => Promise<D>) => Promise<T>
  ): Promise<T> {
    const host = parseExecutionHostId(hostId)
    if (!host) {
      throw new Error('Recipe workspace removal needs a host-qualified workspace.')
    }
    return runWorkspaceLifecycleCommand(
      this.workspaceLifecycle,
      workspaceLifecycleKey(host.id, worktreeId),
      {
        kind: 'delete',
        lostContact: deleteLostContact,
        run: () => remove((destroy) => this.workspaceSleep.destroyVm(worktreeId, destroy)),
        delete: {
          key: getRuntimeWorktreeRemovalOptionsKey({
            force: options.force,
            runHooks: options.runHooks,
            allowUnverifiedPtyStop: options.force,
            allowFailedArchiveHook: options.allowFailedArchiveHook
          }),
          force: options.force,
          label: worktreeId
        }
      }
    )
  }

  /** The user's Suspend VM, serialised with any wake of the same VM. */
  suspendWorkspaceVm(worktreeId: string): Promise<void> {
    return this.workspaceSleep.suspendVm(worktreeId)
  }

  /** Where this workspace's recipe VM stands for a client about to reach its server. */
  workspaceVmState(worktreeId: string, recordSuspended: boolean): RecipeVmState {
    return this.workspaceSleep.vmState(worktreeId, recordSuspended)
  }

  /** Holds a client's open of this workspace until its recipe VM is up, or a later Sleep wins. */
  holdWorkspaceVmOpen(
    worktreeId: string,
    recordSuspended: boolean,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<RecipeVmOpening> {
    return this.workspaceSleep.holdOpen(worktreeId, recordSuspended, timeoutMs, signal)
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
