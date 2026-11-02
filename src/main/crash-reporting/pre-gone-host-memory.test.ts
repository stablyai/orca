import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getSystemMemoryDetails,
  setSystemMemoryInfoReaderForTest,
  withSwapVolumeFreeSpace
} from './system-memory-details'
import {
  readSwapVolumeFreeSpace,
  setSwapVolumeFreeSpaceReaderForTest,
  type SwapVolumeFreeSpace
} from './swap-volume-free-space'
import { samplePreGoneSystemMemory } from './pre-gone-host-memory'
import {
  buildProcessGoneCrashDetails,
  resetPreGoneCrashSamplingForTest,
  samplePreGoneProcessMetrics,
  startPreGoneCrashSampling
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

const BROWSER_ONLY: MetricFixture[] = [BROWSER_AND_RENDERER[0]]

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

// A fixed pagefile cannot grow into free disk; swapTotal alone does not identify its limit.
const FIXED_PAGEFILE_UNDER_PRESSURE = {
  total: 16_000 * 1024,
  free: 300 * 1024,
  swapTotal: 16_100 * 1024,
  swapFree: 180 * 1024
}

const NO_PAGEFILE_UNDER_PRESSURE = {
  ...FIXED_PAGEFILE_UNDER_PRESSURE,
  swapTotal: 15_900 * 1024
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

  it('carries a pre-gone host reading, not only the post-mortem one', async () => {
    setSystemMemoryInfoReaderForTest(() => UNDER_COMMIT_PRESSURE)
    setSwapVolumeFreeSpaceReaderForTest(() => Promise.resolve({ freeMB: 120, volume: 'C:' }))
    await samplePreGoneSystemMemory(Date.now() - 5_000)

    // Simulate memory released by the renderer before the gone-time read.
    setSystemMemoryInfoReaderForTest(() => AFTER_THE_CORPSE_RELEASED)
    appMetricsMock.mockReturnValue(BROWSER_ONLY)

    const details = buildProcessGoneCrashDetails({ processType: 'renderer' }, 'renderer')

    expect(details.systemMemorySwapFreeMB).toBe(2_900)
    expect(details.systemMemoryPreGoneSwapFreeMB).toBe(200)
    expect(details.systemMemoryPreGoneFreeMB).toBe(400)
    expect(details.systemMemoryPreGoneTotalMB).toBe(16_000)
    expect(
      Object.keys(details).filter((key) => key.startsWith('processMetricsPreGoneSystem'))
    ).toEqual([])
  })

  it('reports swap-volume free space so low commit can be told from refused commit', async () => {
    setSystemMemoryInfoReaderForTest(() => UNDER_COMMIT_PRESSURE)
    setSwapVolumeFreeSpaceReaderForTest(() => Promise.resolve({ freeMB: 120, volume: 'C:' }))
    await samplePreGoneSystemMemory(Date.now() - 5_000)

    const details = buildProcessGoneCrashDetails({ processType: 'renderer' }, 'renderer')

    expect(details.systemMemoryPreGoneSwapVolumeFreeMB).toBe(120)
    // The volume reader anchors to SystemRoot, which may differ from the pagefile drive.
    expect(details.systemMemoryPreGoneSwapVolume).toBe('C:')
  })

  it('omits swap-volume free space on Linux, where swap cannot grow into free disk', async () => {
    // Linux root-filesystem space provides no headroom for fixed swap or zram.
    setSwapVolumeFreeSpaceReaderForTest(null)

    await expect(readSwapVolumeFreeSpace('linux')).resolves.toBeUndefined()
  })

  it('labels the reading with the pressure verdict the platform can actually give', () => {
    setSystemMemoryInfoReaderForTest(() => UNDER_COMMIT_PRESSURE)
    const windowsCommit = getSystemMemoryDetails('win32')
    expect(windowsCommit.systemMemoryPressureSignal).toBe('available-commit-unqualified')
    expect(
      withSwapVolumeFreeSpace(windowsCommit, { freeMB: 120, volume: 'C:' }, 'win32')
        .systemMemoryPressureSignal
    ).toBe('available-commit-volume-cotimed')
    expect(
      withSwapVolumeFreeSpace(windowsCommit, { freeMB: 120, volume: 'C:' }, 'win32', false)
        .systemMemoryPressureSignal
    ).toBe('available-commit-unqualified')

    setSystemMemoryInfoReaderForTest(() => ({ total: 16_000 * 1024, free: 400 * 1024 }))
    expect(getSystemMemoryDetails('linux').systemMemoryPressureSignal).toBe('none')

    setSystemMemoryInfoReaderForTest(() => ({ total: 16_000 * 1024, available: 900 * 1024 }))
    expect(getSystemMemoryDetails('linux').systemMemoryPressureSignal).toBe('mem-available')

    setSystemMemoryInfoReaderForTest(() => ({
      total: 16_000 * 1024,
      free: 272 * 1024,
      fileBacked: 2_694 * 1024,
      purgeable: 0
    }))
    expect(getSystemMemoryDetails('darwin').systemMemoryPressureSignal).toBe('none')
  })

  it('never reads free disk as proof the pagefile could have grown', () => {
    setSystemMemoryInfoReaderForTest(() => FIXED_PAGEFILE_UNDER_PRESSURE)
    const fixedPagefile = withSwapVolumeFreeSpace(
      getSystemMemoryDetails('win32'),
      { freeMB: 812_000, volume: 'C:' },
      'win32'
    )
    expect(fixedPagefile.systemMemoryPressureSignal).toBe('available-commit-volume-cotimed')

    setSystemMemoryInfoReaderForTest(() => NO_PAGEFILE_UNDER_PRESSURE)
    expect(
      withSwapVolumeFreeSpace(
        getSystemMemoryDetails('win32'),
        { freeMB: 812_000, volume: 'C:' },
        'win32'
      ).systemMemoryPressureSignal
    ).toBe('available-commit-hard-capped')
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

  it("arms the host sampler on its own unref'd 10 s timer, not the metric sweep's", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const readHostMemory = vi.fn(() => UNDER_COMMIT_PRESSURE)
    setSystemMemoryInfoReaderForTest(readHostMemory)
    setSwapVolumeFreeSpaceReaderForTest(() => Promise.resolve({ freeMB: 120, volume: 'C:' }))
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    try {
      startPreGoneCrashSampling()

      // Assert literal cadences so changing both constants cannot mask a regression.
      expect(setIntervalSpy.mock.calls.map(([, ms]) => ms)).toEqual([60_000, 10_000])
      for (const { value } of setIntervalSpy.mock.results) {
        expect((value as NodeJS.Timeout).hasRef()).toBe(false)
      }
      expect(readHostMemory).toHaveBeenCalledTimes(1)

      readHostMemory.mockReturnValue(AFTER_THE_CORPSE_RELEASED)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(readHostMemory).toHaveBeenCalledTimes(2)
      expect(appMetricsMock).toHaveBeenCalledTimes(1)

      const details = buildProcessGoneCrashDetails({}, 'renderer')
      expect(details.systemMemoryPreGoneSampleAgeMs).toBe(0)
      expect(details.systemMemoryPreGoneSwapFreeMB).toBe(2_900)
    } finally {
      setIntervalSpy.mockRestore()
      vi.useRealTimers()
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

  it('publishes no pre-gone host keys when every memory field failed to read', async () => {
    // Even failed memory reads carry a signal label; that alone must not create a sample.
    setSystemMemoryInfoReaderForTest(() => ({ total: Number.NaN, free: undefined }))
    await samplePreGoneSystemMemory(Date.now())

    const details = buildProcessGoneCrashDetails({}, 'renderer')

    expect(Object.keys(details).filter((key) => key.startsWith('systemMemoryPreGone'))).toEqual([])
  })

  it('carries the last volume reading forward, aged, instead of dropping it', async () => {
    vi.useFakeTimers()
    try {
      setSystemMemoryInfoReaderForTest(() => UNDER_COMMIT_PRESSURE)
      setSwapVolumeFreeSpaceReaderForTest(() => Promise.resolve({ freeMB: 42, volume: 'C:' }))
      await samplePreGoneSystemMemory(0)

      // Leave statfs pending so the new host sample must carry the previous volume reading.
      setSwapVolumeFreeSpaceReaderForTest(() => new Promise<never>(() => {}))
      void samplePreGoneSystemMemory(10_000)
      vi.setSystemTime(10_000)

      const details = buildProcessGoneCrashDetails({}, 'renderer')
      expect(details.systemMemoryPreGoneSwapVolumeFreeMB).toBe(42)
      expect(details.systemMemoryPreGoneSwapVolume).toBe('C:')
      expect(details.systemMemoryPreGoneSampleAgeMs).toBe(0)
      expect(details.systemMemoryPreGoneSwapVolumeAgeMs).toBe(10_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a failed host read from erasing the process-metric sample', async () => {
    samplePreGoneProcessMetrics(Date.now() - 5_000)
    setSystemMemoryInfoReaderForTest(() => {
      throw new Error('getSystemMemoryInfo unavailable')
    })
    await samplePreGoneSystemMemory(Date.now() - 5_000)
    setSystemMemoryInfoReaderForTest(null)

    const details = buildProcessGoneCrashDetails({ processType: 'renderer' }, 'renderer')

    expect(details.processMetricsPreGoneRendererWorkingSetMB).toBe(400)
    expect(Object.keys(details).filter((key) => key.startsWith('systemMemoryPreGone'))).toEqual([])
  })
})
