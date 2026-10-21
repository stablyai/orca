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
  /** Pre-gone MEMORYSTATUSEX.ullAvailPageFile, i.e. commit still available. */
  availableCommitMB: number
  sincePreviousOomMs: number
  /** 'gone-time' when no sampler tick landed since the previous OOM and the gate read commit itself. */
  commitReading: 'pre-gone' | 'gone-time'
}

export type LowCommitOomRecoveryGate = {
  /** Read at gone time; returns a verdict only when auto-reload would run straight back into the OOM. */
  assess: (details: Electron.RenderProcessGoneDetails, now: number) => LowCommitOomVerdict | null
  /** Call only once the death is actually recovered, so a skipped teardown OOM cannot start the repeat window. */
  recordRecoveredDeath: (details: Electron.RenderProcessGoneDetails, goneAt: number) => void
}

type MemoryDetails = Record<string, CrashReportDetailValue>

function usablePreGoneCommitMB(sample: MemoryDetails, sincePreviousOomMs: number): number | null {
  const availableCommitMB = sample[`${SYSTEM_MEMORY_KEY_PREFIX}PreGoneSwapFreeMB`]
  const sampleAgeMs = sample[`${SYSTEM_MEMORY_KEY_PREFIX}PreGoneSampleAgeMs`]
  if (
    typeof availableCommitMB !== 'number' ||
    typeof sampleAgeMs !== 'number' ||
    !Number.isFinite(availableCommitMB) ||
    availableCommitMB < 0 ||
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
      // Why fall back: a 10 s sampler misses most ~3.5 s repeat loops. A gone-time read sees commit the corpse
      // already released, so it can only over-report and miss a prompt, never raise a false one.
      const goneTimeMB =
        preGoneMB === null ? readGoneTimeDetails()[`${SYSTEM_MEMORY_KEY_PREFIX}SwapFreeMB`] : null
      const availableCommitMB = preGoneMB ?? goneTimeMB
      if (
        typeof availableCommitMB !== 'number' ||
        !Number.isFinite(availableCommitMB) ||
        availableCommitMB < 0 ||
        availableCommitMB >= LOW_COMMIT_AVAILABLE_MB_THRESHOLD
      ) {
        return null
      }
      return {
        availableCommitMB,
        sincePreviousOomMs,
        commitReading: preGoneMB === null ? 'gone-time' : 'pre-gone'
      }
    },
    recordRecoveredDeath: (details, goneAt) => {
      if (details.reason === 'oom') {
        previousOomAt = goneAt
      }
    }
  }
}
