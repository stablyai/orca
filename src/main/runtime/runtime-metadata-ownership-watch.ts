import { getRuntimeMetadataPath, type RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { readRuntimeMetadataAsync } from './runtime-metadata'

/** Reclaim dead runtime metadata so CLI can find this still-serving process (#7848); macOS may purge Chromium's lock socket from TMPDIR after 3 days.
 * Reclaim dead pids only: two live profile-sharing runtimes must not fight over the file. */
export const RUNTIME_METADATA_OWNERSHIP_POLL_MS = 10_000

export type RuntimeMetadataOwnershipWatch = {
  /** Runs one ownership check immediately; exposed for tests and eager repair. */
  check: () => Promise<void>
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
  // Only this process can own its pid; mismatched runtimeId means recycled-pid debris, not a live sibling.
  if (current.pid === ownedPid) {
    return true
  }
  return !isProcessRunning(current.pid)
}

export function watchRuntimeMetadataOwnership(
  options: RuntimeMetadataOwnershipWatchOptions
): RuntimeMetadataOwnershipWatch {
  const isProcessRunning = options.isProcessRunning ?? isPidRunning
  let inFlight: Promise<void> | null = null
  const runCheck = async (): Promise<void> => {
    const current = await tryReadRuntimeMetadata(options.userDataPath)
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
      // Retry transient write failure on the next tick.
      console.error('[runtime] Failed to reclaim runtime metadata ownership:', error)
      return
    }
    options.onReclaim?.(current)
  }
  // Serialize off-thread reads so slow volumes cannot stack poll ticks.
  const check = (): Promise<void> => {
    inFlight ??= runCheck().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  const timer = setInterval(
    () => void check(),
    options.pollIntervalMs ?? RUNTIME_METADATA_OWNERSHIP_POLL_MS
  )
  // Discovery bookkeeping must not keep the process alive.
  timer.unref?.()
  return {
    check,
    stop: () => clearInterval(timer)
  }
}

async function tryReadRuntimeMetadata(userDataPath: string): Promise<RuntimeMetadata | null> {
  try {
    return await readRuntimeMetadataAsync(userDataPath)
  } catch (error) {
    // Malformed records cannot guide CLI; reclaim them as missing.
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
    // Only ESRCH proves death; EPERM means another owner still holds the pid, as in socket sweep.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
