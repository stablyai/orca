import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { PhysicalExitTracker } from '../../shared/physical-exit-tracker'
import { WatcherProcessFailure } from './parcel-watcher-process-failure'

export const WSL_WATCHER_PHYSICAL_EXIT_TIMEOUT_MS = 8_000

export function createWslWatcherStartup(): {
  ready: Promise<void>
  readonly settled: boolean
  settle: (error?: Error) => void
} {
  let settled = false
  let resolve!: () => void
  let reject!: (error: Error) => void
  const ready = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return {
    ready,
    get settled() {
      return settled
    },
    settle(error) {
      if (settled) {
        return
      }
      settled = true
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
  }
}

export function createWslWatcherProcessExit(
  child: ChildProcessWithoutNullStreams,
  worktreePath: string,
  onPhysicalExit?: () => void
): {
  markPhysicalExit: () => void
  requestStopBestEffort: () => void
  stopAndWait: () => Promise<void>
} {
  let physicalExited = false
  let stopRequested = false
  const physicalExit = new PhysicalExitTracker()
  const markPhysicalExit = (): void => {
    if (!physicalExited) {
      physicalExited = true
      physicalExit.markExited()
      onPhysicalExit?.()
    }
  }
  const requestStop = (): void => {
    if (physicalExited || stopRequested) {
      return
    }
    stopRequested = true
    try {
      if (!child.kill()) {
        throw new Error('WSL watcher process rejected the termination signal')
      }
    } catch (error) {
      stopRequested = false
      throw error
    }
  }
  const requestStopBestEffort = (): void => {
    try {
      requestStop()
    } catch {
      // The awaited owner retries and retains the child on failure.
    }
  }
  const stopAndWait = async (): Promise<void> => {
    try {
      requestStop()
    } catch (error) {
      throw processExitFailure(
        `Failed to terminate WSL watcher: ${String(error)}`,
        physicalExit.exitedPromise
      )
    }
    await waitForPhysicalExit(worktreePath, physicalExit)
  }
  return { markPhysicalExit, requestStopBestEffort, stopAndWait }
}

function waitForPhysicalExit(
  worktreePath: string,
  physicalExit: PhysicalExitTracker
): Promise<void> {
  return physicalExit.waitForExit(WSL_WATCHER_PHYSICAL_EXIT_TIMEOUT_MS, () =>
    processExitFailure(
      `WSL watcher process did not exit after deadline: ${worktreePath}`,
      physicalExit.exitedPromise
    )
  )
}

function processExitFailure(message: string, physicalExit: Promise<void>): WatcherProcessFailure {
  return new WatcherProcessFailure(message, 'supervisor', 'process_unavailable', physicalExit)
}
