import type { ChildProcess } from 'node:child_process'
import {
  type PendingWatcherUnsubscribe,
  resolvePendingWatcherUnsubscribes
} from './parcel-watcher-host-subscriptions'
import { WatcherProcessFailure } from './parcel-watcher-process-failure'
import { RUNTIME_FILE_WATCH_EXIT_DEADLINE_MS } from '../../shared/runtime-file-watch-limits'

export const WATCHER_PROCESS_HARD_KILL_DELAY_MS = 5_000
export const WATCHER_PROCESS_EXIT_DEADLINE_MS = RUNTIME_FILE_WATCH_EXIT_DEADLINE_MS

const physicalExitPromises = new WeakMap<ChildProcess, Promise<void>>()

export function registerWatcherChildPhysicalExit(child: ChildProcess): () => void {
  let resolveExit: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  physicalExitPromises.set(child, promise)
  return resolveExit
}

export function ignoreWatcherTermination(promise: Promise<void>): void {
  void promise.catch(() => undefined)
}

export class WatcherTerminationQueue {
  private current: Promise<void> | null = null

  waitFor<T>(operation: () => Promise<T>): Promise<T> | null {
    // Why: an idle child may miss its exit deadline without poisoning the
    // reusable supervisor; queued work must re-check state after either result.
    return this.current?.then(operation, operation) ?? null
  }

  getCurrent(): Promise<void> | null {
    return this.current
  }

  track(promise: Promise<void>): Promise<void> {
    const tracked = promise.finally(() => {
      if (this.current === tracked) {
        this.current = null
      }
    })
    this.current = tracked
    ignoreWatcherTermination(tracked)
    return tracked
  }

  resetForTest(): void {
    this.current = null
  }
}

export function terminateWatcherChild(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (exited: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(hardKillTimer)
      clearTimeout(exitDeadlineTimer)
      child.removeListener('exit', onExit)
      child.removeListener('close', onClose)
      resolve(exited)
    }
    const onExit = (): void => finish(true)
    // Why: an asynchronous spawn failure can close without emitting exit; the
    // close event is still definitive proof that the child owns no OS handles.
    const onClose = (): void => finish(true)
    child.once('exit', onExit)
    child.once('close', onClose)
    const hardKillTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // The finite deadline below reports termination failure.
      }
    }, WATCHER_PROCESS_HARD_KILL_DELAY_MS)
    hardKillTimer.unref?.()
    const exitDeadlineTimer = setTimeout(() => finish(false), WATCHER_PROCESS_EXIT_DEADLINE_MS)
    exitDeadlineTimer.unref?.()
    try {
      child.kill()
    } catch {
      finish(false)
    }
  })
}

export function createWatcherChildTerminationFailure(child: ChildProcess): WatcherProcessFailure {
  const physicalExit =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : (physicalExitPromises.get(child) ??
        new Promise<void>((resolve) => {
          const finish = (): void => {
            child.removeListener('exit', finish)
            child.removeListener('close', finish)
            resolve()
          }
          child.once('exit', finish)
          child.once('close', finish)
        }))
  return new WatcherProcessFailure(
    'file watcher process did not exit after termination deadline',
    'supervisor',
    'process_unavailable',
    physicalExit
  )
}

export async function requireWatcherChildTermination(child: ChildProcess): Promise<void> {
  if (!(await terminateWatcherChild(child))) {
    throw createWatcherChildTerminationFailure(child)
  }
}

export async function terminateIdleWatcherChild(
  child: ChildProcess,
  pendingUnsubscribes: Map<number, PendingWatcherUnsubscribe>,
  onFinished: (exited: boolean) => void
): Promise<void> {
  try {
    await requireWatcherChildTermination(child)
    onFinished(true)
  } catch (error) {
    onFinished(false)
    resolvePendingWatcherUnsubscribes(
      pendingUnsubscribes,
      error instanceof Error ? error : new Error(String(error))
    )
    throw error
  }
  resolvePendingWatcherUnsubscribes(pendingUnsubscribes)
}
