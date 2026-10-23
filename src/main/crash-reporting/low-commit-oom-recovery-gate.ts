import type { CrashReportDetailValue } from '../../shared/crash-reporting'
import { preGoneSystemMemoryDetails } from './pre-gone-host-memory'
import { getSystemMemoryDetails, SYSTEM_MEMORY_KEY_PREFIX } from './system-memory-details'

// Why: when Windows commit is exhausted by another program, a recovery reload OOMs again within seconds
// (launch 13084: 3.5 s after the reload; launch 22912: 34 s), so a repeat OOM on a starved host asks the user instead.
export const LOW_COMMIT_REPEAT_OOM_WINDOW_MS = 5 * 60_000
export const LOW_COMMIT_AVAILABLE_MB_THRESHOLD = 512
// Two missed 10 s sampler ticks: an older reading may predate the squeeze or its relief.
const LOW_COMMIT_MAX_SAMPLE_AGE_MS = 30_000

export type LowCommitOomVerdict = {
  /** MEMORYSTATUSEX.ullAvailPageFile, i.e. commit still available: the lower of the usable readings. */
  availableCommitMB: number
  sincePreviousOomMs: number
  /** Which reading supplied availableCommitMB; 'gone-time' is the gate's own read at gone time. */
  commitReading: 'pre-gone' | 'gone-time'
}

export type LowCommitOomRecoveryGate = {
  /** Read at gone time; returns a verdict only when auto-reload would run straight back into the OOM. */
  assess: (details: Electron.RenderProcessGoneDetails, now: number) => LowCommitOomVerdict | null
  /** Call only once the death is actually recovered, so a skipped teardown OOM cannot start the repeat window. */
  recordRecoveredDeath: (details: Electron.RenderProcessGoneDetails, goneAt: number) => void
}

type MemoryDetails = Record<string, CrashReportDetailValue>

function usableCommitMB(value: CrashReportDetailValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function usablePreGoneCommitMB(sample: MemoryDetails, sincePreviousOomMs: number): number | null {
  const availableCommitMB = usableCommitMB(sample[`${SYSTEM_MEMORY_KEY_PREFIX}PreGoneSwapFreeMB`])
  const sampleAgeMs = sample[`${SYSTEM_MEMORY_KEY_PREFIX}PreGoneSampleAgeMs`]
  if (
    availableCommitMB === null ||
    typeof sampleAgeMs !== 'number' ||
    !Number.isFinite(sampleAgeMs) ||
    sampleAgeMs < 0 ||
    sampleAgeMs > LOW_COMMIT_MAX_SAMPLE_AGE_MS ||
    // Why: a reading from before the previous OOM misses the commit that corpse released.
    sampleAgeMs >= sincePreviousOomMs
  ) {
    return null
  }
  return availableCommitMB
}

export function createLowCommitOomRecoveryGate(
  readPreGoneDetails: (now: number) => MemoryDetails = preGoneSystemMemoryDetails,
  readGoneTimeDetails: () => MemoryDetails = getSystemMemoryDetails
): LowCommitOomRecoveryGate {
  let previousOomAt: number | null = null
  return {
    assess: (details, now) => {
      const previous = previousOomAt
      if (
        // Only win32 swapFree is available commit; elsewhere it is not a verdict.
        process.platform !== 'win32' ||
        details.reason !== 'oom' ||
        previous === null ||
        !Number.isFinite(now) ||
        now <= previous ||
        now - previous > LOW_COMMIT_REPEAT_OOM_WINDOW_MS
      ) {
        return null
      }
      const sincePreviousOomMs = now - previous
      const preGoneMB = usablePreGoneCommitMB(readPreGoneDetails(now), sincePreviousOomMs)
      // Why also read at gone time: a 10 s sampler misses most ~3.5 s repeat loops, and commit can keep falling
      // after the last tick (Scan-36: 515 MB pre-gone, 195 MB at gone time). A gone-time read sees commit the
      // corpse already released, so taking the lower reading can only miss a prompt, never raise a false one.
      const goneTimeMB = usableCommitMB(
        readGoneTimeDetails()[`${SYSTEM_MEMORY_KEY_PREFIX}SwapFreeMB`]
      )
      const useGoneTime = goneTimeMB !== null && (preGoneMB === null || goneTimeMB < preGoneMB)
      const availableCommitMB = useGoneTime ? goneTimeMB : preGoneMB
      if (availableCommitMB === null || availableCommitMB >= LOW_COMMIT_AVAILABLE_MB_THRESHOLD) {
        return null
      }
      return {
        availableCommitMB,
        sincePreviousOomMs,
        commitReading: useGoneTime ? 'gone-time' : 'pre-gone'
      }
    },
    recordRecoveredDeath: (details, goneAt) => {
      if (details.reason === 'oom') {
        previousOomAt = goneAt
      }
    }
  }
}
