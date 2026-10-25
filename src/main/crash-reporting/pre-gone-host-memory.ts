import type { CrashReportDetailValue } from '../../shared/crash-reporting'
import { readSwapVolumeFreeSpace } from './swap-volume-free-space'
import {
  getSystemMemoryDetails,
  SYSTEM_MEMORY_KEY_PREFIX,
  withSwapVolumeFreeSpace
} from './system-memory-details'

// Sample frequently: post-exit reads can hide transient pressure after memory is released.

export const PRE_GONE_SYSTEM_MEMORY_SAMPLE_INTERVAL_MS = 10_000

type CrashReportDetails = Record<string, CrashReportDetailValue>

type PreGoneSystemMemorySample = {
  details: CrashReportDetails
  sampledAtMs: number
  /** Time of the tick that issued statfs, even if it resolved on a later tick. */
  swapVolumeSampledAtMs?: number
}

let preGoneSample: PreGoneSystemMemorySample | null = null
let preGoneTimer: ReturnType<typeof setInterval> | null = null
let swapVolumeReadInFlight = false
let samplingGeneration = 0
let sampleTick = 0

const PRESSURE_SIGNAL_KEY = `${SYSTEM_MEMORY_KEY_PREFIX}PressureSignal`

// Carry the last volume reading with its own age; delayed statfs must not erase it.
function withCarriedSwapVolume(sample: PreGoneSystemMemorySample): PreGoneSystemMemorySample {
  const previous = preGoneSample
  if (!previous || previous.swapVolumeSampledAtMs === undefined) {
    return sample
  }
  const freeMB = previous.details[`${SYSTEM_MEMORY_KEY_PREFIX}SwapVolumeFreeMB`]
  const volume = previous.details[`${SYSTEM_MEMORY_KEY_PREFIX}SwapVolume`]
  if (typeof freeMB !== 'number' || typeof volume !== 'string') {
    return sample
  }
  return {
    ...sample,
    details: withSwapVolumeFreeSpace(sample.details, { freeMB, volume }, process.platform, false),
    swapVolumeSampledAtMs: previous.swapVolumeSampledAtMs
  }
}

function commitHostMemorySample(nowMs: number): boolean {
  try {
    const details = getSystemMemoryDetails()
    // The unconditional signal label does not prove any memory field was read.
    if (!Object.keys(details).some((key) => key !== PRESSURE_SIGNAL_KEY)) {
      return false
    }
    preGoneSample = withCarriedSwapVolume({ details, sampledAtMs: nowMs })
    return true
  } catch {
    // Preserve the last good sample on read failure.
    return false
  }
}

async function mergeSwapVolumeFreeSpace(issuedOnTick: number): Promise<void> {
  if (swapVolumeReadInFlight) {
    return
  }
  swapVolumeReadInFlight = true
  const generation = samplingGeneration
  const issuedFor = preGoneSample
  try {
    const volume = await readSwapVolumeFreeSpace()
    if (volume && preGoneSample && generation === samplingGeneration) {
      // Failed host reads retain sample identity, so only the issuing tick proves co-timing.
      const coTimed = issuedOnTick === sampleTick
      preGoneSample = {
        ...preGoneSample,
        details: withSwapVolumeFreeSpace(preGoneSample.details, volume, process.platform, coTimed),
        swapVolumeSampledAtMs: issuedFor?.sampledAtMs
      }
    }
  } catch {
    // Keep the committed memory reading if the supplemental volume read fails.
  } finally {
    swapVolumeReadInFlight = false
  }
}

export async function samplePreGoneSystemMemory(nowMs: number = Date.now()): Promise<void> {
  // Commit host memory before statfs, which may stall under paging pressure.
  const tick = ++sampleTick
  if (!commitHostMemorySample(nowMs)) {
    return
  }
  await mergeSwapVolumeFreeSpace(tick)
}

export function startPreGoneSystemMemorySampling(
  intervalMs: number = PRE_GONE_SYSTEM_MEMORY_SAMPLE_INTERVAL_MS
): void {
  if (preGoneTimer) {
    return
  }
  void samplePreGoneSystemMemory()
  preGoneTimer = setInterval(() => void samplePreGoneSystemMemory(), intervalMs)
  preGoneTimer.unref?.()
}

export function resetPreGoneSystemMemorySamplingForTest(): void {
  if (preGoneTimer) {
    clearInterval(preGoneTimer)
  }
  preGoneTimer = null
  preGoneSample = null
  swapVolumeReadInFlight = false
  // Invalidate pending volume reads so they cannot repopulate a reset sample.
  samplingGeneration += 1
}

export function preGoneSystemMemoryDetails(nowMs: number): CrashReportDetails {
  if (!preGoneSample) {
    return {}
  }
  const details: CrashReportDetails = {
    [`${SYSTEM_MEMORY_KEY_PREFIX}PreGoneSampleAgeMs`]: Math.max(
      0,
      nowMs - preGoneSample.sampledAtMs
    )
  }
  // Asynchronous volume reads need their own age rather than the host sample's age.
  if (preGoneSample.swapVolumeSampledAtMs !== undefined) {
    details[`${SYSTEM_MEMORY_KEY_PREFIX}PreGoneSwapVolumeAgeMs`] = Math.max(
      0,
      nowMs - preGoneSample.swapVolumeSampledAtMs
    )
  }
  for (const [key, value] of Object.entries(preGoneSample.details)) {
    details[`${SYSTEM_MEMORY_KEY_PREFIX}PreGone${key.slice(SYSTEM_MEMORY_KEY_PREFIX.length)}`] =
      value
  }
  return details
}
