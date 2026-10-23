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

import { hostSleepKey } from '../terminal/stop/worktree-terminal-sleep-key'
import { resolveWorktreeHostRouting, type LaunchHostRepo } from '../worktree-launch-host-repo'
import type {
  LifecycleCommand,
  LifecycleDeleteOptions,
  LifecycleOutcome
} from './workspace-lifecycle-command'
import type { WorkspaceLifecycleQueue } from './workspace-lifecycle-queue'

type RemovalFlag = 'force' | 'runHooks' | 'allowUnverifiedPtyStop' | 'allowFailedArchiveHook'

/** One key per host's copy of a workspace, the same one its terminals sleep under. */
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

/** Runs `command` in its workspace's queue, or directly in a build with none. */
export function runWorkspaceLifecycleCommand<T>(
  queue: WorkspaceLifecycleQueue | null,
  key: string,
  command: LifecycleCommand<T>
): Promise<T> {
  return queue ? queue.submit(key, command) : command.run()
}

const LIVENESS_UNAVAILABLE = 'terminal_liveness_unavailable'

/** A thrown terminal command that lost the host's liveness answer; any other error is definite. */
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

/** Re-reads the workspace's terminal liveness; throws only while the host still cannot answer. */
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

/** The sync key of an `id:` selector routed by the repo rows; null when only a lookup can say. */
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

/** The key a lookup finds: the workspace's own host, else as the repo rows route it. */
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

/** `terminal.sleep`, `terminal.closeAll` and `worktree.sleep` as queued commands, in arrival order. */
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

/**
 * `worktree.rm`: keyed by the workspace's resolved id, whatever selector named it, so a delete by
 * name waits for that workspace's running sleep. A workspace no lookup finds runs unqueued.
 */
export function queueWorkspaceDelete<T>(
  runtime: LifecycleRuntime & ObservingRuntime,
  selector: string,
  hostId: string | undefined,
  requested: Partial<Record<RemovalFlag, boolean>>,
  /** Called with the normalized flags, plus the caller's host when it named one. */
  run: (removal: Record<RemovalFlag, boolean> & { hostId?: string }) => Promise<T>
): Promise<T> {
  const removal: Record<RemovalFlag, boolean> = {
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
