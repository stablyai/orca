import type { CrashReportDetailValue } from '../../shared/crash-reporting'
import { preGoneSystemMemoryDetails } from './pre-gone-host-memory'
import { isRendererAllocationCheckCrash } from './renderer-allocation-check-signatures'
import { getSystemMemoryDetails, SYSTEM_MEMORY_KEY_PREFIX } from './system-memory-details'

// Why: when Windows commit is exhausted by another program, a recovery reload OOMs again within seconds
// (launch 13084: 3.5 s after the reload; launch 22912: 34 s), so a repeat OOM on a starved host asks the user instead.
export const LOW_COMMIT_REPEAT_OOM_WINDOW_MS = 5 * 60_000
export const LOW_COMMIT_AVAILABLE_MB_THRESHOLD = 512
// Two missed 10 s sampler ticks: an older reading may predate the squeeze or its relief.
const LOW_COMMIT_MAX_SAMPLE_AGE_MS = 30_000
// Why: a starved host does not always die as 'oom' — Scan-37 r29 died of an allocation CHECK, then the reload
// died of STATUS_STACK_OVERFLOW (the guard page could not be committed), both reported as 'crashed'.
const STATUS_STACK_OVERFLOW = -1073741571
const STATUS_BREAKPOINT = -2147483645

const MAX_RECOVERED_DEATHS = 4

/** 'check' is a CHECK that counts only once its dump names an allocation failure. */
type OomShape = 'oom' | 'stack-overflow' | 'check'

function oomShape(details: Electron.RenderProcessGoneDetails): OomShape | null {
  if (details.reason === 'oom') {
    return 'oom'
  }
  if (details.reason !== 'crashed') {
    return null
  }
  if (details.exitCode === STATUS_STACK_OVERFLOW) {
    return 'stack-overflow'
  }
  return details.exitCode === STATUS_BREAKPOINT ? 'check' : null
}

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
  /** Call at recovery time before honoring a verdict: a CHECK's dump is parsed only after gone time. */
  confirmsHold: (details: Electron.RenderProcessGoneDetails, goneAt: number) => boolean
  /** Call only once the death is actually recovered, so a skipped teardown OOM cannot start the repeat window. */
  recordRecoveredDeath: (details: Electron.RenderProcessGoneDetails, goneAt: number) => void
}

type MemoryDetails = Record<string, CrashReportDetailValue>

function usableCommitMB(value: CrashReportDetailValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function usablePreGoneCommitMB(
  sample: MemoryDetails,
  sinceLatestDeathMs: number | null
): number | null {
  const availableCommitMB = usableCommitMB(sample[`${SYSTEM_MEMORY_KEY_PREFIX}PreGoneSwapFreeMB`])
  const sampleAgeMs = sample[`${SYSTEM_MEMORY_KEY_PREFIX}PreGoneSampleAgeMs`]
  if (
    availableCommitMB === null ||
    typeof sampleAgeMs !== 'number' ||
    !Number.isFinite(sampleAgeMs) ||
    sampleAgeMs < 0 ||
    sampleAgeMs > LOW_COMMIT_MAX_SAMPLE_AGE_MS ||
    // Why: a reading from before the previous recovered death misses the commit that corpse released.
    (sinceLatestDeathMs !== null && sampleAgeMs >= sinceLatestDeathMs)
  ) {
    return null
  }
  return availableCommitMB
}

export function createLowCommitOomRecoveryGate(
  readPreGoneDetails: (now: number) => MemoryDetails = preGoneSystemMemoryDetails,
  readGoneTimeDetails: () => MemoryDetails = getSystemMemoryDetails,
  isAllocationCheckCrash: (goneAt: number) => boolean = isRendererAllocationCheckCrash
): LowCommitOomRecoveryGate {
  // Newest last; kept past one because an unconfirmed 'check' must not hide the real OOM before it.
  const recovered: { at: number; shape: OomShape }[] = []
  // A 'crashed' death counts as an OOM only when its own reading at gone time showed commit exhausted.
  let lowCommitCrash: { details: Electron.RenderProcessGoneDetails; at: number } | null = null
  // Why lazily: the dump that names a CHECK lands after gone time, so a 'check' counts once a later death asks.
  const counts = (shape: OomShape, at: number): boolean =>
    shape !== 'check' || isAllocationCheckCrash(at)
  return {
    assess: (details, now) => {
      lowCommitCrash = null
      // Only win32 swapFree is available commit; elsewhere it is not a verdict.
      const shape = process.platform === 'win32' ? oomShape(details) : null
      if (shape === null || !Number.isFinite(now)) {
        return null
      }
      const previous = recovered.findLast(
        (death) =>
          now > death.at &&
          now - death.at <= LOW_COMMIT_REPEAT_OOM_WINDOW_MS &&
          counts(death.shape, death.at)
      )
      const sincePreviousOomMs = previous === undefined ? null : now - previous.at
      // A first 'oom' needs no reading: it records unconditionally.
      if (shape === 'oom' && sincePreviousOomMs === null) {
        return null
      }
      const latest = recovered.at(-1)
      const sinceLatestDeathMs = latest === undefined ? null : Math.max(0, now - latest.at)
      const preGoneMB = usablePreGoneCommitMB(readPreGoneDetails(now), sinceLatestDeathMs)
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
      if (shape !== 'oom') {
        lowCommitCrash = { details, at: now }
      }
      if (sincePreviousOomMs === null) {
        return null
      }
      return {
        availableCommitMB,
        sincePreviousOomMs,
        commitReading: useGoneTime ? 'gone-time' : 'pre-gone'
      }
    },
    confirmsHold: (details, goneAt) => {
      const shape = oomShape(details)
      return shape !== null && counts(shape, goneAt)
    },
    recordRecoveredDeath: (details, goneAt) => {
      const shape = oomShape(details)
      if (
        shape === 'oom' ||
        (shape !== null && lowCommitCrash?.details === details && lowCommitCrash.at === goneAt)
      ) {
        recovered.push({ at: goneAt, shape })
        if (recovered.length > MAX_RECOVERED_DEATHS) {
          recovered.shift()
        }
      }
      lowCommitCrash = null
    }
  }
}
