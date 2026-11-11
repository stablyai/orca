import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setSystemMemoryInfoReaderForTest } from './system-memory-details'
import {
  setSwapVolumeFreeSpaceReaderForTest,
  type SwapVolumeFreeSpace
} from './swap-volume-free-space'
import { samplePreGoneSystemMemory } from './pre-gone-host-memory'
import {
  buildProcessGoneCrashDetails,
  resetPreGoneCrashSamplingForTest
} from './process-gone-diagnostics'

type MetricFixture = {
  pid: number
  creationTime: number
  type: string
  memory: { workingSetSize: number; peakWorkingSetSize?: number; privateBytes?: number }
}

const { appMetricsMock } = vi.hoisted(() => ({
  appMetricsMock: vi.fn<() => MetricFixture[]>(() => [])
}))

vi.mock('electron', () => ({ app: { getAppMetrics: appMetricsMock } }))

const BROWSER_AND_RENDERER: MetricFixture[] = [
  { pid: 10, creationTime: 1, type: 'Browser', memory: { workingSetSize: 1024 * 250 } },
  {
    pid: 11,
    creationTime: 2,
    type: 'Tab',
    memory: { workingSetSize: 1024 * 400, peakWorkingSetSize: 1024 * 420, privateBytes: 1024 * 260 }
  }
]

const UNDER_COMMIT_PRESSURE = {
  total: 16_000 * 1024,
  free: 400 * 1024,
  swapTotal: 48_000 * 1024,
  swapFree: 200 * 1024
}

const AFTER_THE_CORPSE_RELEASED = {
  total: 16_000 * 1024,
  free: 3_000 * 1024,
  swapTotal: 48_000 * 1024,
  swapFree: 2_900 * 1024
}

const BEFORE_THE_STORM = {
  total: 16_000 * 1024,
  free: 9_000 * 1024,
  swapTotal: 48_000 * 1024,
  swapFree: 30_000 * 1024
}

describe('pre-gone host memory', () => {
  beforeEach(() => {
    resetPreGoneCrashSamplingForTest()
    setSystemMemoryInfoReaderForTest(null)
    setSwapVolumeFreeSpaceReaderForTest(null)
    appMetricsMock.mockClear()
    appMetricsMock.mockReturnValue(BROWSER_AND_RENDERER)
  })

  it('will not let a statfs that outlived its tick qualify the win32 commit verdict', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.useFakeTimers()
    let resolveVolume: (value: SwapVolumeFreeSpace) => void = () => {}
    try {
      setSystemMemoryInfoReaderForTest(() => BEFORE_THE_STORM)
      setSwapVolumeFreeSpaceReaderForTest(
        () =>
          new Promise<SwapVolumeFreeSpace>((resolve) => {
            resolveVolume = resolve
          })
      )
      void samplePreGoneSystemMemory(0)

      // Later ticks refresh host memory while the original statfs remains pending.
      setSystemMemoryInfoReaderForTest(() => UNDER_COMMIT_PRESSURE)
      await samplePreGoneSystemMemory(10_000)
      await samplePreGoneSystemMemory(20_000)

      resolveVolume({ freeMB: 40_000, volume: 'C:' })
      await vi.advanceTimersByTimeAsync(0)

      vi.setSystemTime(20_000)
      const stale = buildProcessGoneCrashDetails({}, 'renderer')
      expect(stale.systemMemoryPreGoneSwapFreeMB).toBe(200)
      expect(stale.systemMemoryPreGoneSwapVolumeFreeMB).toBe(40_000)
      expect(stale.systemMemoryPreGoneSampleAgeMs).toBe(0)
      expect(stale.systemMemoryPreGoneSwapVolumeAgeMs).toBe(20_000)
      expect(stale.systemMemoryPreGonePressureSignal).toBe('available-commit-unqualified')

      setSwapVolumeFreeSpaceReaderForTest(() => Promise.resolve({ freeMB: 900, volume: 'C:' }))
      await samplePreGoneSystemMemory(30_000)
      vi.setSystemTime(30_000)
      const fresh = buildProcessGoneCrashDetails({}, 'renderer')
      expect(fresh.systemMemoryPreGoneSwapVolumeFreeMB).toBe(900)
      expect(fresh.systemMemoryPreGoneSwapVolumeAgeMs).toBe(0)
      expect(fresh.systemMemoryPreGonePressureSignal).toBe('available-commit-volume-cotimed')
    } finally {
      vi.useRealTimers()
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('will not let ticks with a failed host read pass a stale statfs off as co-timed', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.useFakeTimers()
    let resolveVolume: (value: SwapVolumeFreeSpace) => void = () => {}
    try {
      setSystemMemoryInfoReaderForTest(() => BEFORE_THE_STORM)
      setSwapVolumeFreeSpaceReaderForTest(
        () =>
          new Promise<SwapVolumeFreeSpace>((resolve) => {
            resolveVolume = resolve
          })
      )
      void samplePreGoneSystemMemory(0)

      setSystemMemoryInfoReaderForTest(() => null)
      await samplePreGoneSystemMemory(10_000)
      await samplePreGoneSystemMemory(20_000)

      resolveVolume({ freeMB: 40_000, volume: 'C:' })
      await vi.advanceTimersByTimeAsync(0)

      vi.setSystemTime(25_000)
      const details = buildProcessGoneCrashDetails({}, 'renderer')
      expect(details.systemMemoryPreGoneSwapVolumeAgeMs).toBe(25_000)
      expect(details.systemMemoryPreGonePressureSignal).toBe('available-commit-unqualified')
    } finally {
      vi.useRealTimers()
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('commits the host reading without waiting on the swap-volume statfs', async () => {
    setSystemMemoryInfoReaderForTest(() => UNDER_COMMIT_PRESSURE)
    setSwapVolumeFreeSpaceReaderForTest(() => new Promise(() => {}))

    void samplePreGoneSystemMemory(Date.now() - 5_000)
    expect(buildProcessGoneCrashDetails({}, 'renderer').systemMemoryPreGoneSwapFreeMB).toBe(200)

    setSystemMemoryInfoReaderForTest(() => AFTER_THE_CORPSE_RELEASED)
    void samplePreGoneSystemMemory(Date.now())
    expect(buildProcessGoneCrashDetails({}, 'renderer').systemMemoryPreGoneSwapFreeMB).toBe(2_900)
  })
})
