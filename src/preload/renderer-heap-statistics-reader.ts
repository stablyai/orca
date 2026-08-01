import type { RendererHeapStatistics } from '../shared/renderer-heap-statistics'

type HeapStatisticsSource = Pick<NodeJS.Process, 'getHeapStatistics' | 'getBlinkMemoryInfo'>

/**
 * Reads exact V8 heap sizes, which `performance.memory` cannot express: Blink
 * quantizes that API and caches it ~20 minutes, so heap growth is invisible to
 * it. Available in a sandboxed, context-isolated preload.
 */
export function readRendererHeapStatistics(
  source: HeapStatisticsSource = process
): RendererHeapStatistics | null {
  let heap: Electron.HeapStatistics
  try {
    heap = source.getHeapStatistics()
  } catch {
    // Why: diagnostics must never break the renderer if Electron drops an API.
    return null
  }

  let blinkAllocatedKB: number | undefined
  try {
    // Why a separate try: Blink's number is supplementary. Losing it must not
    // discard the exact V8 read and send callers back to the quantized metric.
    blinkAllocatedKB = source.getBlinkMemoryInfo().allocated
  } catch {
    blinkAllocatedKB = undefined
  }

  return {
    usedHeapKB: heap.usedHeapSize,
    totalHeapKB: heap.totalHeapSize,
    heapLimitKB: heap.heapSizeLimit,
    physicalKB: heap.totalPhysicalSize,
    availableKB: heap.totalAvailableSize,
    executableKB: heap.totalHeapSizeExecutable,
    mallocedKB: heap.mallocedMemory,
    peakMallocedKB: heap.peakMallocedMemory,
    blinkAllocatedKB
  }
}
