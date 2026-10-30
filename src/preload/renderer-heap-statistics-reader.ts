import type { RendererHeapStatistics } from '../shared/renderer-heap-statistics'

type HeapStatisticsSource = Pick<NodeJS.Process, 'getHeapStatistics' | 'getBlinkMemoryInfo'>

// performance.memory quantizes and caches values, hiding heap growth.
export function readRendererHeapStatistics(
  source: HeapStatisticsSource = process
): RendererHeapStatistics | null {
  let heap: Electron.HeapStatistics
  try {
    heap = source.getHeapStatistics()
  } catch {
    // Diagnostics must tolerate missing Electron APIs.
    return null
  }

  let blinkAllocatedKB: number | undefined
  try {
    // A failed supplementary Blink read must not discard the V8 measurements.
    blinkAllocatedKB = source.getBlinkMemoryInfo().allocated
  } catch {
    blinkAllocatedKB = undefined
  }

  return {
    usedHeapKB: heap.usedHeapSize,
    totalHeapKB: heap.totalHeapSize,
    heapLimitKB: heap.heapSizeLimit,
    mallocedKB: heap.mallocedMemory,
    blinkAllocatedKB
  }
}
