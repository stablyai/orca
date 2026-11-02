import type { CrashReportDetailValue } from '../../shared/crash-reporting'
import { preGoneSystemMemoryDetails } from './pre-gone-host-memory'
import { getSystemMemoryDetails, SYSTEM_MEMORY_KEY_PREFIX } from './system-memory-details'

// Repeated reloads can immediately OOM again while Windows commit remains exhausted.
export const LOW_COMMIT_REPEAT_OOM_WINDOW_MS = 5 * 60_000
export const LOW_COMMIT_AVAILABLE_MB_THRESHOLD = 512
// Reject stale readings that may predate the commit squeeze or its relief.
const LOW_COMMIT_MAX_SAMPLE_AGE_MS = 30_000

export type LowCommitOomVerdict = {
  /** Available Windows commit (MEMORYSTATUSEX.ullAvailPageFile), in MB. */
  availableCommitMB: number
  sincePreviousOomMs: number
  /** Identifies the sampled or synchronous source of the available-commit reading. */
  commitReading: 'pre-gone' | 'gone-time'
}

export type LowCommitOomRecoveryGate = {
  /** Assess at renderer death whether low commit warrants prompting before another reload. */
  assess: (details: Electron.RenderProcessGoneDetails, now: number) => LowCommitOomVerdict | null
  /** Record only recovered deaths so skipped teardown OOMs cannot start the window. */
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
    // A reading before the previous OOM misses commit freed by that process exiting.
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
        // Only Windows swapFree measures available commit.
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
      // Fast repeats can outrun sampling; post-exit reads may overstate commit and miss a prompt.
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
