import { execFileSync } from 'node:child_process'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parsePhysicalFootprintBytes,
  parseProcessCpuTimeMs,
  sampleProductionPerformance
} from './hang-watchdog-process-metrics.mjs'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  execFileSync: vi.fn()
}))
vi.mock('node:perf_hooks', async (importOriginal) => ({
  ...(await importOriginal()),
  monitorEventLoopDelay: vi.fn()
}))

const observations = { events: [], readCpu: null, histogram: null }

describe('hang watchdog process metrics', () => {
  it('uses the de-duplicated summary for multiple processes', () => {
    const output = `
Electron [101]: 64-bit    Footprint: 5000000 B (16384 bytes per page)
    phys_footprint: 5100000 B
Electron Helper [102]: 64-bit    Footprint: 2000000 B (16384 bytes per page)
    phys_footprint: 2100000 B
Summary Footprint: 6259264 B
`
    expect(parsePhysicalFootprintBytes(output, 2)).toBe(6_259_264)
  })

  it('uses the process footprint rather than auxiliary accounting for one process', () => {
    const output = `
Electron [101]: 64-bit    Footprint: 5000000 B (16384 bytes per page)
    phys_footprint: 5100000 B
`
    expect(parsePhysicalFootprintBytes(output, 1)).toBe(5_000_000)
  })

  it('rejects missing or zero footprint summaries', () => {
    expect(parsePhysicalFootprintBytes('phys_footprint: 100 B', 2)).toBeNull()
    expect(parsePhysicalFootprintBytes('Summary Footprint: 0 B', 2)).toBeNull()
  })

  it.each([
    ['0:00.04', 40],
    ['1:02.50', 62_500],
    ['2:01:02.50', 7_262_500]
  ])('parses ps CPU time %s', (value, expected) => {
    expect(parseProcessCpuTimeMs(value)).toBe(expected)
  })

  it('rejects invalid CPU times', () => {
    expect(parseProcessCpuTimeMs('')).toBeNull()
    expect(parseProcessCpuTimeMs('not-a-time')).toBeNull()
    expect(parseProcessCpuTimeMs('-1:00')).toBeNull()
  })
})

function cpuObservation(pid) {
  return ['cpu', 'ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }]
}

describe('production watchdog sample lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    observations.events = []
    let enabled = false
    observations.histogram = {
      enable() {
        observations.events.push(['enable'])
        const changed = !enabled
        enabled = true
        return changed
      },
      disable() {
        observations.events.push(['disable'])
        const changed = enabled
        enabled = false
        return changed
      },
      percentile: (value) => {
        observations.events.push(['percentile', value])
        return value === 95 ? 1_900_000 : 3_100_000
      },
      max: 5_000_000
    }
    vi.mocked(execFileSync).mockImplementation((command, args, options) => {
      observations.events.push(['cpu', command, args, options])
      return observations.readCpu()
    })
    vi.mocked(monitorEventLoopDelay).mockImplementation((options) => {
      observations.events.push(['monitor', options])
      return observations.histogram
    })
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it.each([1, 2])('clears the heartbeat when initial CPU observation %s throws', async (failAt) => {
    const error = new Error('PID observation failed')
    let reads = 0
    observations.readCpu = () => {
      if (++reads === failAt) {
        throw error
      }
      return '0:01.20'
    }
    const sendHeartbeat = vi.fn()
    const sleep = vi.fn()
    await expect(
      sampleProductionPerformance(
        { pids: [101, 102], sendHeartbeat },
        { heartbeatIntervalMs: 2_000, sampleMs: 30_000, sleep }
      )
    ).rejects.toBe(error)
    expect(reads).toBe(failAt)
    expect(sleep).not.toHaveBeenCalled()
    expect(observations.events.filter(([kind]) => kind !== 'disable')).toEqual([
      ['monitor', { resolution: 10 }],
      ...[101, 102].slice(0, failAt).map(cpuObservation)
    ])
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(sendHeartbeat).not.toHaveBeenCalled()
  })

  it('preserves an invalid CPU diagnostic while releasing the heartbeat', async () => {
    observations.readCpu = () => 'invalid CPU time'
    const sendHeartbeat = vi.fn()
    const sleep = vi.fn()
    await expect(
      sampleProductionPerformance(
        { pids: [101], sendHeartbeat },
        { heartbeatIntervalMs: 2_000, sampleMs: 30_000, sleep }
      )
    ).rejects.toThrow('Could not read CPU time for PID 101')
    expect(sleep).not.toHaveBeenCalled()
    expect(observations.events.filter(([kind]) => kind !== 'disable')).toEqual([
      ['monitor', { resolution: 10 }],
      cpuObservation(101)
    ])
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(sendHeartbeat).not.toHaveBeenCalled()
  })

  it('repeated failed owners leave no timers or later sends', async () => {
    const error = new Error('sample CPU failure')
    observations.readCpu = () => {
      throw error
    }
    const sendHeartbeat = vi.fn()
    const sleep = vi.fn()
    for (let index = 0; index < 64; index++) {
      await expect(
        sampleProductionPerformance(
          { pids: [101], sendHeartbeat },
          { heartbeatIntervalMs: 2_000, sampleMs: 30_000, sleep }
        )
      ).rejects.toBe(error)
    }
    expect(sleep).not.toHaveBeenCalled()
    expect(observations.events.filter(([kind]) => kind !== 'disable')).toEqual(
      Array.from({ length: 64 }, () => [
        ['monitor', { resolution: 10 }],
        cpuObservation(101)
      ]).flat()
    )
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(sendHeartbeat).not.toHaveBeenCalled()
  })

  async function runSample({ values, sleepError } = {}) {
    const cpuValues = values ?? ['0:01.20', '0:02.30', '0:01.25', '0:02.35']
    let index = 0
    observations.readCpu = () => {
      const value = cpuValues[index++]
      if (value instanceof Error) {
        throw value
      }
      return value
    }
    const sendHeartbeat = vi.fn(() => observations.events.push(['heartbeat']))
    const sleep = async (ms) => {
      observations.events.push(['sleep', ms])
      await vi.advanceTimersByTimeAsync(ms)
      if (sleepError) {
        throw sleepError
      }
    }
    return sampleProductionPerformance(
      { pids: [101, 102], sendHeartbeat },
      { heartbeatIntervalMs: 2_000, sampleMs: 6_000, sleep }
    )
  }

  const completedSampleEvents = [
    ['monitor', { resolution: 10 }],
    cpuObservation(101),
    cpuObservation(102),
    ['enable'],
    ['sleep', 6_000],
    ['heartbeat'],
    ['heartbeat'],
    ['heartbeat'],
    ['disable']
  ]

  it('keeps complete live results, observation order and heartbeat pacing', async () => {
    expect(await runSample()).toEqual({
      cpuMs: 100,
      heartbeatCount: 3,
      eventLoopDelayP95Ms: 1.9,
      eventLoopDelayP99Ms: 3.1,
      eventLoopDelayMaxMs: 5
    })
    expect(observations.events).toEqual([
      ...completedSampleEvents,
      cpuObservation(101),
      cpuObservation(102),
      ['percentile', 95],
      ['percentile', 99]
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a sample sleep rejection and its existing cleanup', async () => {
    const error = new Error('sample sleep rejected')
    await expect(runSample({ sleepError: error })).rejects.toBe(error)
    expect(observations.events).toEqual(completedSampleEvents)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a final CPU observation failure after cleanup', async () => {
    const error = new Error('final CPU read failed')
    await expect(runSample({ values: ['0:01.20', '0:02.30', error] })).rejects.toBe(error)
    expect(observations.events).toEqual([...completedSampleEvents, cpuObservation(101)])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the zero floor when the CPU total decreases', async () => {
    expect(await runSample({ values: ['0:02.20', '0:03.30', '0:01.25', '0:02.35'] })).toEqual({
      cpuMs: 0,
      heartbeatCount: 3,
      eventLoopDelayP95Ms: 1.9,
      eventLoopDelayP99Ms: 3.1,
      eventLoopDelayMaxMs: 5
    })
    expect(vi.getTimerCount()).toBe(0)
  })
})
