import { describe, expect, it } from 'vitest'
import { sampleProcessTreeUntilWorkloadsComplete } from './idle-cpu-process-sampling.mjs'

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
