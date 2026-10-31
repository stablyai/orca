import type {
  RuntimeWorktreeTerminalCloseResult,
  RuntimeWorktreeTerminalSleepResult
} from '../../../shared/runtime-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { splitWorktreeId } from '../../../shared/worktree/id'
import {
  isProvenLivePtyRemovalError,
  isUnstoppedPtyRemovalError
} from '../../../shared/worktree/removal'
import {
  getExplicitWorktreeIdSelector,
  getRuntimeWorktreeRemovalOptionsKey
} from '../runtime-worktree-selection'

import type { RemoveManagedWorktreeOptions } from '../runtime-worktree-selection'
import { hostSleepKey } from '../terminal/stop/worktree-terminal-sleep-key'
import { resolveWorktreeHostRouting, type LaunchHostRepo } from '../worktree-launch-host-repo'
import type {
  LifecycleCommand,
  LifecycleDeleteOptions,
  LifecycleOutcome
} from './workspace-lifecycle-command'
import type { WorkspaceLifecycleQueue } from './workspace-lifecycle-queue'

type RemovalFlag = 'force' | 'runHooks' | 'allowUnverifiedPtyStop' | 'allowFailedArchiveHook'

export function workspaceLifecycleKey(hostId: ExecutionHostId, worktreeId: string): string {
  return hostSleepKey(hostId, worktreeId)
}

type LifecycleRuntime = {
  readonly workspaceLifecycle: WorkspaceLifecycleQueue | null
  listRepos: () => readonly LaunchHostRepo[]
  showManagedWorktree: (
    selector: string
  ) => Promise<{ id: string; repoId: string; hostId?: string | null }>
}

type ObservingRuntime = {
  listTerminals: (
    selector: string,
    limit: number,
    opts: { requireFreshPtyLiveness?: boolean }
  ) => Promise<unknown>
}

export function runWorkspaceLifecycleCommand<T>(
  queue: WorkspaceLifecycleQueue | null,
  key: string,
  command: LifecycleCommand<T>
): Promise<T> {
  return queue ? queue.submit(key, command) : command.run()
}

const LIVENESS_UNAVAILABLE = 'terminal_liveness_unavailable'

export function terminalLostContact(error: unknown): boolean {
  return error instanceof Error && error.message === LIVENESS_UNAVAILABLE
}

// The host could not say whether the stops took; a terminal observed still live is definite.
export function sleepOutcome(result: RuntimeWorktreeTerminalSleepResult): LifecycleOutcome {
  return result.postStopVerified === false && result.postStopFailure === LIVENESS_UNAVAILABLE
    ? 'unverifiable'
    : 'settled'
}

export function closeOutcome(result: RuntimeWorktreeTerminalCloseResult): LifecycleOutcome {
  return result.ptyStopVerdict === 'unverifiable' ? 'unverifiable' : 'settled'
}

/** A delete whose PTY stop went unproven (not seen live) lost contact; any other error is definite. */
export function deleteLostContact(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return (
    error.message === LIVENESS_UNAVAILABLE ||
    (isUnstoppedPtyRemovalError(error.message) && !isProvenLivePtyRemovalError(error.message))
  )
}

export function observeTerminals(runtime: ObservingRuntime, selector: string) {
  return async (): Promise<void> => {
    try {
      await runtime.listTerminals(selector, 1, { requireFreshPtyLiveness: true })
    } catch (error) {
      // Any other answer (the workspace is gone, say) is the host answering.
      if (terminalLostContact(error)) {
        throw error
      }
    }
  }
}

export function explicitKey(
  repos: readonly LaunchHostRepo[],
  selector: string,
  hostId?: string | null
): string | null {
  const worktreeId = getExplicitWorktreeIdSelector(selector)
  const repoId = worktreeId ? splitWorktreeId(worktreeId)?.repoId : undefined
  if (!worktreeId || !repoId) {
    return null
  }
  const named = parseExecutionHostId(hostId ?? undefined)?.id
  if (named) {
    return workspaceLifecycleKey(named, worktreeId)
  }
  const routing = resolveWorktreeHostRouting(repos, { repoId })
  if (routing.kind === 'ambiguous') {
    return null
  }
  return workspaceLifecycleKey(
    routing.kind === 'resolved' ? routing.hostId : LOCAL_EXECUTION_HOST_ID,
    worktreeId
  )
}

async function lookedUpKey(
  runtime: LifecycleRuntime,
  selector: string,
  hostId?: string
): Promise<string> {
  const worktree = await runtime.showManagedWorktree(selector)
  const named = parseExecutionHostId(hostId ?? worktree.hostId ?? undefined)?.id
  if (named) {
    return workspaceLifecycleKey(named, worktree.id)
  }
  const routing = resolveWorktreeHostRouting(runtime.listRepos(), worktree)
  if (routing.kind === 'ambiguous') {
    throw new Error('worktree_execution_host_unresolved')
  }
  return workspaceLifecycleKey(
    routing.kind === 'resolved' ? routing.hostId : LOCAL_EXECUTION_HOST_ID,
    worktree.id
  )
}

export function queueTerminalWorkspaceCommand<T>(
  runtime: LifecycleRuntime,
  selector: string,
  command: LifecycleCommand<T>
): Promise<T> {
  const queue = runtime.workspaceLifecycle
  if (!queue) {
    return command.run()
  }
  const key = explicitKey(runtime.listRepos(), selector)
  return key
    ? queue.submit(key, command)
    : queue.submitResolving(() => lookedUpKey(runtime, selector), command)
}

/** Resolve the workspace id before queueing so name-based deletes wait for its sleep; unresolved workspaces run unqueued. */
export function queueWorkspaceDelete<T>(
  runtime: LifecycleRuntime & ObservingRuntime,
  selector: string,
  hostId: string | undefined,
  requested: Partial<Record<RemovalFlag, boolean>> &
    Pick<RemoveManagedWorktreeOptions, 'deleteBranch'>,
  run: (
    removal: Record<RemovalFlag, boolean> &
      Pick<RemoveManagedWorktreeOptions, 'hostId' | 'deleteBranch'>
  ) => Promise<T>
): Promise<T> {
  const removal = {
    ...(requested.deleteBranch !== undefined ? { deleteBranch: requested.deleteBranch } : {}),
    force: requested.force === true,
    runHooks: requested.runHooks === true,
    allowUnverifiedPtyStop: requested.allowUnverifiedPtyStop === true,
    allowFailedArchiveHook: requested.allowFailedArchiveHook === true
  }
  const options: LifecycleDeleteOptions = {
    key: getRuntimeWorktreeRemovalOptionsKey(removal),
    force: removal.allowUnverifiedPtyStop,
    label: getExplicitWorktreeIdSelector(selector) ?? selector
  }
  const command: LifecycleCommand<T> = {
    kind: 'delete',
    run: () => run({ ...removal, ...(hostId ? { hostId } : {}) }),
    lostContact: deleteLostContact,
    observe: observeTerminals(runtime, selector),
    delete: options
  }
  const queue = runtime.workspaceLifecycle
  if (!queue) {
    return command.run()
  }
  const key = explicitKey(runtime.listRepos(), selector, hostId)
  return key
    ? queue.submit(key, command)
    : queue.submitResolving(
        () =>
          lookedUpKey(runtime, selector, hostId).catch((error: unknown) => {
            // A delete legitimately reaches a workspace Git no longer lists; nothing orders it.
            if (error instanceof Error && error.message === 'selector_not_found') {
              return null
            }
            throw error
          }),
        command
      )
}
