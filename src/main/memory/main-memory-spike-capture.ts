import { getHeapSpaceStatistics, getHeapStatistics } from 'node:v8'
import type { CrashReportDetailValue } from '../../shared/crash-reporting/crash-reporting'
import { hasActiveTraceSink, startSpan } from '../observability/tracer'
import { readWorkerThreadMemoryData } from '../worker-threads/worker-thread-diagnostics'

/**
 * Main's footprint jumping by hundreds of MB names no owner after the fact, so a rise this large
 * within this window writes one breakdown to the local trace log. Triggers on the OS footprint
 * (macOS phys_footprint, Windows private bytes, Linux anonymous RSS plus swap) because the working
 * set misses memory the OS compresses or swaps out. Rides the 10 s host-memory tick, which catches
 * a 60 s spike that a once-a-minute sample can miss.
 */
export const MAIN_MEMORY_SPIKE_RISE_MB = 300
export const MAIN_MEMORY_SPIKE_WINDOW_MS = 2 * 60_000
/** Ticks fire late (more so on a busy main), so the oldest sample can be just past the window. */
const SAMPLE_LATENESS_SLACK_MS = 30_000
export const MAIN_MEMORY_SPIKE_MIN_INTERVAL_MS = 60 * 60_000
const MB = 2 ** 20

type Details = Record<string, CrashReportDetailValue>
type Sample = { atMs: number; mb: number }

/** Counts only, never names or paths. */
export type MainMemorySpikeCounts = () => Record<string, number>

const recent: Sample[] = []
let armedAtMs: number | null = null
let lastCaptureAtMs = Number.NEGATIVE_INFINITY
let readCounts: MainMemorySpikeCounts | null = null
let readProcessMetrics: (() => Details) | null = null
let sampleInFlight = false

export function setMainMemorySpikeCounts(counts: MainMemorySpikeCounts | null): void {
  readCounts = counts
}

/** Read at capture time, so the per-process breakdown describes the spike rather than a minute before. */
export function setMainMemorySpikeProcessMetrics(read: (() => Details) | null): void {
  readProcessMetrics = read
}

/** One in-process OS footprint read; skipped while the last read is pending or tracing is off. */
export async function sampleMainMemoryFootprint(): Promise<void> {
  if (
    sampleInFlight ||
    !hasActiveTraceSink() ||
    typeof process.getProcessMemoryInfo !== 'function'
  ) {
    return
  }
  sampleInFlight = true
  try {
    const info = await process.getProcessMemoryInfo()
    observeMainMemorySample(Math.round(info.private / 1024), Date.now())
  } catch {
    // A failed read skips one sample.
  } finally {
    sampleInFlight = false
  }
}

export function observeMainMemorySample(footprintMB: number, nowMs: number): void {
  // Launch loads the profile in its first minutes; that ramp is expected, not a spike.
  armedAtMs ??= nowMs + MAIN_MEMORY_SPIKE_WINDOW_MS
  if (nowMs < armedAtMs) {
    return
  }
  while (
    recent.length > 0 &&
    nowMs - recent[0].atMs > MAIN_MEMORY_SPIKE_WINDOW_MS + SAMPLE_LATENESS_SLACK_MS
  ) {
    recent.shift()
  }
  let baseline: Sample = { atMs: nowMs, mb: footprintMB }
  for (const sample of recent) {
    if (sample.mb < baseline.mb) {
      baseline = sample
    }
  }
  recent.push({ atMs: nowMs, mb: footprintMB })
  if (
    footprintMB - baseline.mb < MAIN_MEMORY_SPIKE_RISE_MB ||
    nowMs - lastCaptureAtMs < MAIN_MEMORY_SPIKE_MIN_INTERVAL_MS ||
    !hasActiveTraceSink()
  ) {
    return
  }
  lastCaptureAtMs = nowMs
  void captureMainMemorySpike({
    footprintMB,
    baselineMB: baseline.mb,
    baselineAgeMs: nowMs - baseline.atMs
  })
}

async function captureMainMemorySpike(trigger: {
  footprintMB: number
  baselineMB: number
  baselineAgeMs: number
}): Promise<void> {
  const span = startSpan('memory.main-spike', {
    attributes: {
      mainFootprintMB: trigger.footprintMB,
      baselineFootprintMB: trigger.baselineMB,
      riseMB: trigger.footprintMB - trigger.baselineMB,
      baselineAgeMs: trigger.baselineAgeMs
    }
  })
  const record = (attributes: Details): void => {
    for (const [key, value] of Object.entries(attributes)) {
      span.setAttribute(key, value)
    }
  }
  // Synchronous reads first, so they describe the moment of the spike; a failed part names itself.
  for (const [part, read] of [
    ['node', nodeMemory],
    ['v8', v8Heap],
    ['counts', countsData],
    ['processMetrics', () => readProcessMetrics?.() ?? {}]
  ] as const) {
    try {
      record(read())
    } catch {
      span.setAttribute(`${part}Error`, true)
    }
  }
  const [allocator, workers] = await Promise.allSettled([
    allocatorTotals(),
    readWorkerThreadMemoryData()
  ])
  record(allocator.status === 'fulfilled' ? allocator.value : { chromiumError: true })
  record(workers.status === 'fulfilled' ? workers.value : { workersError: true })
  span.end()
}

function toMB(bytes: number): number {
  return Math.round(bytes / MB)
}

function nodeMemory(): Details {
  const usage = process.memoryUsage()
  return {
    rssMB: toMB(usage.rss),
    heapTotalMB: toMB(usage.heapTotal),
    heapUsedMB: toMB(usage.heapUsed),
    externalMB: toMB(usage.external),
    arrayBuffersMB: toMB(usage.arrayBuffers)
  }
}

function v8Heap(): Details {
  const heap = getHeapStatistics()
  const details: Details = {
    v8TotalHeapMB: toMB(heap.total_heap_size),
    v8UsedHeapMB: toMB(heap.used_heap_size),
    v8PhysicalMB: toMB(heap.total_physical_size),
    v8MallocedMB: toMB(heap.malloced_memory),
    v8PeakMallocedMB: toMB(heap.peak_malloced_memory),
    v8ExternalMB: toMB(heap.external_memory),
    v8HeapLimitMB: toMB(heap.heap_size_limit),
    v8NativeContexts: heap.number_of_native_contexts,
    v8DetachedContexts: heap.number_of_detached_contexts
  }
  for (const space of getHeapSpaceStatistics()) {
    details[`v8Space_${space.space_name}_usedMB`] = toMB(space.space_used_size)
  }
  return details
}

/** Chromium's per-process totals; its full allocator dump needs a trace session, which stays opt-in. */
async function allocatorTotals(): Promise<Details> {
  if (typeof process.getProcessMemoryInfo !== 'function') {
    return {}
  }
  const info = await process.getProcessMemoryInfo()
  return {
    chromiumSharedMB: Math.round(info.shared / 1024),
    ...(info.residentSet ? { chromiumResidentSetMB: Math.round(info.residentSet / 1024) } : {})
  }
}

function countsData(): Details {
  const counts = readCounts?.() ?? {}
  return Object.fromEntries(Object.entries(counts).map(([key, value]) => [`count_${key}`, value]))
}

export function resetMainMemorySpikeCaptureForTest(): void {
  recent.length = 0
  armedAtMs = null
  lastCaptureAtMs = Number.NEGATIVE_INFINITY
  readCounts = null
  readProcessMetrics = null
  sampleInFlight = false
}
