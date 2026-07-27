import { describe, expect, it, vi } from 'vitest'
import { readRendererHeapStatistics } from './renderer-heap-statistics-reader'

const heapStatistics = {
  totalHeapSize: 2048,
  totalHeapSizeExecutable: 0,
  totalPhysicalSize: 2048,
  totalAvailableSize: 4_000_000,
  usedHeapSize: 1536,
  heapSizeLimit: 4_292_608,
  mallocedMemory: 64,
  peakMallocedMemory: 96,
  doesZapGarbage: false
}

const source = (overrides: {
  heap?: () => Electron.HeapStatistics
  blink?: () => Electron.BlinkMemoryInfo
}): Parameters<typeof readRendererHeapStatistics>[0] =>
  ({
    getHeapStatistics: overrides.heap ?? ((): Electron.HeapStatistics => heapStatistics),
    getBlinkMemoryInfo:
      overrides.blink ?? ((): Electron.BlinkMemoryInfo => ({ allocated: 1227, total: 1280 }))
  }) as Parameters<typeof readRendererHeapStatistics>[0]

describe('readRendererHeapStatistics', () => {
  it('reports V8 sizes in the kilobytes Electron returns', () => {
    expect(readRendererHeapStatistics(source({}))).toEqual({
      usedHeapKB: 1536,
      totalHeapKB: 2048,
      heapLimitKB: 4_292_608,
      mallocedKB: 64,
      blinkAllocatedKB: 1227
    })
  })

  it('keeps the exact V8 read when only the Blink metric throws', () => {
    // Why: Blink's number is supplementary. Discarding the V8 read over its
    // absence would send callers back to the quantized `performance.memory`
    // this reader exists to replace — silently defeating the whole feature.
    const result = readRendererHeapStatistics(
      source({
        blink: () => {
          throw new Error('getBlinkMemoryInfo unavailable')
        }
      })
    )

    expect(result).toEqual({
      usedHeapKB: 1536,
      totalHeapKB: 2048,
      heapLimitKB: 4_292_608,
      mallocedKB: 64,
      blinkAllocatedKB: undefined
    })
  })

  it('returns null only when the primary V8 read fails', () => {
    const blink = vi.fn()

    expect(
      readRendererHeapStatistics(
        source({
          heap: () => {
            throw new Error('getHeapStatistics unavailable')
          },
          blink: blink as never
        })
      )
    ).toBeNull()
    // Why: no reason to pay for the auxiliary call once the result is unusable.
    expect(blink).not.toHaveBeenCalled()
  })
})
