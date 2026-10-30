import type { RuntimeWorktreeTerminalSleepResult } from '../../../shared/runtime-types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import type {
  WorkspaceSleepNotice,
  WorkspaceSleepOutcome,
  WorkspaceSleepRequest
} from '../../../shared/workspace-sleep'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { RemoteWorkspaceCall } from './remote-workspace-terminal-sleep'
import {
  sleepWorkspaces,
  type WorkspaceSleepDeps,
  type WorkspaceSleepQueue
} from './workspace-sleep-execution'
import type { WorkspaceSleepPlatform } from './workspace-sleep-platform'
import type { LaunchHostRepo } from '../worktree-launch-host-repo'
import type { WorkspaceLifecycleQueue } from './workspace-lifecycle-queue'
import { WORKSPACE_DELETED_ERROR } from './workspace-lifecycle-command'
import type { RestoredPane, StartedPty } from '../terminal/recovery/restored-pane-start'
import {
  explicitKey,
  observeTerminals,
  queueTerminalWorkspaceCommand,
  runWorkspaceLifecycleCommand,
  workspaceLifecycleKey
} from './workspace-lifecycle-commands'

export type WorkspaceSleepRuntime = {
  readonly workspaceLifecycle: WorkspaceLifecycleQueue | null
  readonly workspaceSleepPlatform: WorkspaceSleepPlatform | null
  listRepos: () => readonly LaunchHostRepo[]
  showManagedWorktree: (
    selector: string
  ) => Promise<{ id: string; repoId: string; hostId?: string | null }>
  listTerminals: (
    selector: string,
    limit: number,
    opts: { requireFreshPtyLiveness?: boolean }
  ) => Promise<unknown>
  sleepTerminalsForWorktree: (selector: string) => Promise<RuntimeWorktreeTerminalSleepResult>
  ensureStructuredAgentSessionHost: () => Promise<void>
  notifyWorkspaceSleep: (notice: WorkspaceSleepNotice) => void
  wakeRecordsForWorktree: (worktreeId: string) => SleepingAgentSessionRecord[]
  resumeSleptWorkspaceAgents: (worktreeId: string) => Promise<void>
  ensureRestoredPaneStarted: (
    pane: RestoredPane,
    trigger?: { automatic?: boolean }
  ) => Promise<StartedPty | null>
  /** The window's wake of its own completed-agent hibernation, which main does not hold. */
  wakeWindowHibernatedAgents: (worktreeId: string) => void
}

/** The paired server's answer, as a call that throws its refusal with the code kept. */
function environmentCall(platform: WorkspaceSleepPlatform | null, environmentId: string) {
  const call: RemoteWorkspaceCall = async (method, params, timeoutMs) => {
    if (!platform) {
      throw Object.assign(new Error('This host has no paired servers.'), {
        code: 'runtime_environment_unavailable'
      })
    }
    const response = await platform.callEnvironment(environmentId, method, params, timeoutMs)
    if (response.ok) {
      return response.result
    }
    // The code survives, so an older server's method_not_found takes the legacy sleep.
    throw Object.assign(new Error(response.error.message), { code: response.error.code })
  }
  return call
}

/** A sleep that kept the workspace open, left a chat unconfirmed, or left its VM running. */
function needsWindowToast(outcome: WorkspaceSleepOutcome): boolean {
  // A delete that cancelled the sleep removed the workspace; nothing was kept open.
  return (
    (outcome.failure !== undefined && outcome.failure !== WORKSPACE_DELETED_ERROR) ||
    outcome.chatFailed ||
    outcome.vmSuspendFailure !== undefined
  )
}

export class WorkspaceSleepCoordinator {
  /** Reopening during sleep prevents subsequent VM suspension. */
  private readonly reopenings = new Map<string, number>()

  constructor(private readonly runtime: WorkspaceSleepRuntime) {}

  sleep(request: WorkspaceSleepRequest): Promise<WorkspaceSleepOutcome[]> {
    return sleepWorkspaces(this.deps(), this.queue(), request)
  }

  /** A phone is answered on acceptance: it ignores the result and chat stops can outlast its request timeout. */
  async sleepOwnWorktree(
    worktreeId: string,
    opts: { replyOnAcceptance?: boolean; markChatsAsleep?: boolean }
  ): Promise<{ worktreeId: string } & Partial<WorkspaceSleepOutcome>> {
    const self = { kind: 'self' } as const
    const sleeping = this.sleep({
      targets: [{ worktreeId, terminalHost: self, chatHosts: [self] }],
      markChatsAsleep: opts.markChatsAsleep !== false
    }).then((outcomes) => {
      // The phone cannot report sleep failures, so notify the desktop.
      for (const outcome of outcomes.filter(needsWindowToast)) {
        this.runtime.notifyWorkspaceSleep({ worktreeId, phase: 'failed', outcome })
      }
      return outcomes
    })
    if (opts.replyOnAcceptance) {
      void sleeping.catch((error: unknown) =>
        console.error('[workspace-sleep] sleep failed', { worktreeId, error })
      )
      return { worktreeId }
    }
    const [slept] = await sleeping
    // An unproven stop is never reported as asleep.
    if (slept?.failure) {
      throw new Error(slept.failure)
    }
    return slept ?? { worktreeId }
  }

  noteReopened(worktreeId: string): void {
    this.reopenings.set(worktreeId, (this.reopenings.get(worktreeId) ?? 0) + 1)
  }

  /** Queue wake behind sleep and await agent starts so later sleep/delete cannot overtake it. */
  wake(worktreeId: string): Promise<void> {
    this.noteReopened(worktreeId)
    return queueTerminalWorkspaceCommand(this.runtime, `id:${worktreeId}`, {
      kind: 'wake',
      run: async () => {
        await this.runtime.resumeSleptWorkspaceAgents(worktreeId)
        this.runtime.wakeWindowHibernatedAgents(worktreeId)
      }
    })
  }

  /** A slept pane was opened: main resumes it, queued like any wake, and the opener attaches. */
  resumePane(pane: RestoredPane, automatic = false): Promise<boolean> {
    if (!automatic) {
      this.noteReopened(pane.worktreeId)
    }
    return queueTerminalWorkspaceCommand(this.runtime, `id:${pane.worktreeId}`, {
      kind: 'wake',
      run: async () => (await this.runtime.ensureRestoredPaneStarted(pane, { automatic })) !== null
    })
  }

  private deps(): WorkspaceSleepDeps {
    const { runtime } = this
    const platform = runtime.workspaceSleepPlatform
    return {
      notify: (notice) => runtime.notifyWorkspaceSleep(notice),
      sleepOwnTerminals: (worktreeId) => runtime.sleepTerminalsForWorktree(`id:${worktreeId}`),
      callEnvironment: (environmentId) => environmentCall(platform, environmentId),
      stopOwnChats: async (worktreeId, markAsleep) => {
        await runtime.ensureStructuredAgentSessionHost()
        const host = getStructuredAgentSessionHost()
        if (!host) {
          throw new Error('structured_agent_session_host_unavailable')
        }
        return host.sleepWorkspace(worktreeId, markAsleep)
      },
      suspendVm: platform ? (worktreeId) => platform.suspendVm(worktreeId) : null,
      ownRecords: (worktreeId) => runtime.wakeRecordsForWorktree(worktreeId),
      watchReopen: (worktreeId) => {
        const at = this.reopenings.get(worktreeId) ?? 0
        return () => (this.reopenings.get(worktreeId) ?? 0) !== at
      }
    }
  }

  private queue(): WorkspaceSleepQueue {
    const { runtime } = this
    const environmentKey = (environmentId: string, worktreeId: string): string =>
      workspaceLifecycleKey(toRuntimeExecutionHostId(environmentId), worktreeId)
    return {
      paused: (target) => {
        const host = target.terminalHost
        const key =
          host.kind === 'environment'
            ? environmentKey(host.environmentId, target.worktreeId)
            : explicitKey(runtime.listRepos(), `id:${target.worktreeId}`)
        return key !== null && runtime.workspaceLifecycle?.pausedKeys().includes(key) === true
      },
      submit: (target, command) => {
        const host = target.terminalHost
        const selector = `id:${target.worktreeId}`
        if (host.kind === 'environment') {
          const call = environmentCall(runtime.workspaceSleepPlatform, host.environmentId)
          const key = environmentKey(host.environmentId, target.worktreeId)
          return runWorkspaceLifecycleCommand(runtime.workspaceLifecycle, key, {
            ...command,
            // Any answer from the server, even a refusal, is the server answering.
            observe: async () => {
              try {
                await call('terminal.list', { worktree: selector, limit: 1 }, 15_000)
              } catch (error) {
                if (!(error instanceof Error && 'code' in error)) {
                  throw error
                }
              }
            }
          })
        }
        return queueTerminalWorkspaceCommand(runtime, selector, {
          ...command,
          observe: observeTerminals(runtime, selector)
        })
      }
    }
  }
}
