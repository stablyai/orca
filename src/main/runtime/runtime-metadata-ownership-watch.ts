import { getRuntimeMetadataPath, type RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { readRuntimeMetadata } from './runtime-metadata'

/**
 * Why: `orca-runtime.json` is the CLI's only pointer at a live runtime, and it
 * can stop describing this process while this process is still serving RPC —
 * a second instance that slipped past the single-instance lock publishes its
 * own pid and then exits, leaving the CLI on a dead pid (`stale_bootstrap`)
 * against a healthy app (#7848). Chromium's lock is defeated on macOS whenever
 * `SingletonSocket`/`SingletonCookie` go missing, and its socket lives under
 * `$TMPDIR` (`/var/folders/.../T`), which macOS itself purges after 3 days.
 *
 * The owner therefore watches its own record and reclaims it once no live
 * runtime is described. Reclaiming only a dead pid is deliberate: two live
 * runtimes sharing a profile would otherwise ping-pong the file forever.
 */
export const RUNTIME_METADATA_OWNERSHIP_POLL_MS = 10_000

export type RuntimeMetadataOwnershipWatch = {
  /** Runs one ownership check immediately; exposed for tests and eager repair. */
  check: () => void
  stop: () => void
}

export type RuntimeMetadataOwnershipWatchOptions = {
  userDataPath: string
  ownedPid: number
  ownedRuntimeId: string
  republish: () => void
  pollIntervalMs?: number
  isProcessRunning?: (pid: number) => boolean
  onReclaim?: (previous: RuntimeMetadata | null) => void
}

export function shouldReclaimRuntimeMetadata(
  current: RuntimeMetadata | null,
  ownedPid: number,
  ownedRuntimeId: string,
  isProcessRunning: (pid: number) => boolean
): boolean {
  if (!current) {
    return true
  }
  if (current.pid === ownedPid && current.runtimeId === ownedRuntimeId) {
    return false
  }
  // Why: only this process can legitimately claim this pid, so a foreign
  // runtimeId on it is a leftover from a recycled pid, not a live sibling.
  if (current.pid === ownedPid) {
    return true
  }
  return !isProcessRunning(current.pid)
}

export function watchRuntimeMetadataOwnership(
  options: RuntimeMetadataOwnershipWatchOptions
): RuntimeMetadataOwnershipWatch {
  const isProcessRunning = options.isProcessRunning ?? isPidRunning
  const check = (): void => {
    const current = tryReadRuntimeMetadata(options.userDataPath)
    if (
      !shouldReclaimRuntimeMetadata(
        current,
        options.ownedPid,
        options.ownedRuntimeId,
        isProcessRunning
      )
    ) {
      return
    }
    try {
      options.republish()
    } catch (error) {
      // Why: a transient write failure must not kill the watch; the next tick retries.
      console.error('[runtime] Failed to reclaim runtime metadata ownership:', error)
      return
    }
    options.onReclaim?.(current)
  }

  const timer = setInterval(check, options.pollIntervalMs ?? RUNTIME_METADATA_OWNERSHIP_POLL_MS)
  // Why: discovery bookkeeping must never be the reason the process stays alive.
  timer.unref?.()
  return {
    check,
    stop: () => clearInterval(timer)
  }
}

function tryReadRuntimeMetadata(userDataPath: string): RuntimeMetadata | null {
  try {
    return readRuntimeMetadata(userDataPath)
  } catch (error) {
    // Why: an unparseable record is as useless to the CLI as a missing one, so treat it as reclaimable.
    console.warn(
      `[runtime] Ignoring unreadable ${getRuntimeMetadataPath(userDataPath)}:`,
      error instanceof Error ? error.message : String(error)
    )
    return null
  }
}

function isPidRunning(pid: number): boolean {
  if (!pid || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Why: only ESRCH proves the pid is gone; EPERM means a foreign owner holds it (same rule as the socket sweep).
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
