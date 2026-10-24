import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  cimCpuSeconds,
  readProcessRows,
  sampleProcessTreeUntilWorkloadsComplete
} from './idle-cpu-process-sampling.mjs'

function createClock(workloadCompletesAt) {
  let currentMs = 0
  let resolveWorkload
  const workloadPromise = new Promise((resolve) => {
    resolveWorkload = resolve
  })
  const wait = async (durationMs) => {
    currentMs += durationMs
    if (currentMs >= workloadCompletesAt) {
      resolveWorkload('complete')
    }
    await Promise.resolve()
  }
  const readRows = () => [
    {
      pid: 10,
      ppid: 0,
      percentCpu: 0,
      rssBytes: 1_024,
      cpuTimeSeconds: currentMs / 2_000,
      command: 'electron'
    }
  ]
  return { now: () => currentMs, readRows, wait, workloadPromise }
}

describe('Windows CIM CPU time mapping', () => {
  it('converts the 100ns user and kernel times to a summed second count', () => {
    // 10_000_000 and 25_000_000 units of 100ns are 1s and 2.5s.
    expect(cimCpuSeconds({ UserModeTime: 10_000_000, KernelModeTime: 25_000_000 })).toBe(3.5)
  })

  it('maps a missing or non-numeric time to null instead of a kernel-only reading', () => {
    expect(cimCpuSeconds({ UserModeTime: null, KernelModeTime: 10_000_000 })).toBeNull()
    expect(cimCpuSeconds({ KernelModeTime: 10_000_000 })).toBeNull()
    expect(cimCpuSeconds({ UserModeTime: '10000000', KernelModeTime: 10_000_000 })).toBeNull()
    expect(cimCpuSeconds({ UserModeTime: Number.NaN, KernelModeTime: 10_000_000 })).toBeNull()
    expect(
      cimCpuSeconds({ UserModeTime: Number.POSITIVE_INFINITY, KernelModeTime: 10_000_000 })
    ).toBeNull()
  })
})

describe.skipIf(process.platform !== 'win32')('Windows process table read', () => {
  // Not a latency budget: this is often the runner's first Windows PowerShell 5.1 start, which
  // takes 10-19 s on packaged CI and has reached 48 s. Above the reader's own 60 s bound.
  it('parses a command line whose characters the OEM code page maps to control bytes', () => {
    const marker = 'idle-cpu-oem • → ♪'
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)', marker], {
      stdio: 'ignore'
    })
    try {
      const row = readProcessRows().find((candidate) => candidate.pid === child.pid)
      expect(row?.command).toContain(marker)
      expect(row?.cpuTimeSeconds).toEqual(expect.any(Number))
    } finally {
      child.kill()
    }
  }, 75_000)
})

describe('idle CPU process sampling window', () => {
  it('extends through a slow workload and captures a final CPU delta', async () => {
    const clock = createClock(40)
    const result = await sampleProcessTreeUntilWorkloadsComplete({
      rootPid: 10,
      requestedDurationMs: 20,
      intervalMs: 10,
      maxWorkloadOverrunMs: 100,
      ...clock
    })

    expect(result.workloadResult).toBe('complete')
    expect(result.samples.map((sample) => sample.at)).toEqual([10, 20, 30, 40])
    expect(result.samples.at(-1)).toEqual({
      at: 40,
      elapsedMs: 10,
      totalCpuPercent: expect.closeTo(50, 8),
      totalRssBytes: 1_024,
      processes: [
        {
          pid: 10,
          ppid: 0,
          percentCpu: 0,
          rssBytes: 1_024,
          cpuTimeSeconds: 0.02,
          command: 'electron',
          kind: 'main',
          cpu: expect.closeTo(50, 8)
        }
      ]
    })
    expect(result.samplingWindow).toEqual({
      requestedDurationMs: 20,
      measuredDurationMs: 40,
      maxWorkloadOverrunMs: 100,
      extendedForWorkload: true,
      workloadSettledElapsedMs: 40,
      workloadSettledBeforeStop: true
    })
  })

  it('invalidates a run that reaches the workload overrun guard', async () => {
    const clock = createClock(Infinity)
    await expect(
      sampleProcessTreeUntilWorkloadsComplete({
        rootPid: 10,
        requestedDurationMs: 20,
        intervalMs: 10,
        maxWorkloadOverrunMs: 20,
        ...clock
      })
    ).rejects.toThrow('exceeded the 20ms sampling overrun limit')
  })
})
