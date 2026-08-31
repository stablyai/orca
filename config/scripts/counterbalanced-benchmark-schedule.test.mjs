import { describe, expect, it } from 'vitest'

import {
  BENCHMARK_SAMPLE_AGGREGATION,
  summarizeBenchmarkSamples
} from './benchmark-sample-summary.mjs'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function linearDriftSamples(schedule, trueDuration, driftPerLaunch) {
  const samples = { login: [], fast: [] }
  schedule.flat().forEach((arm, launchIndex) => {
    samples[arm].push(trueDuration[arm] + launchIndex * driftPerLaunch)
  })
  return samples
}

describe('counterbalanced benchmark schedule', () => {
  it('builds complete ABBA blocks', () => {
    expect(buildCounterbalancedSchedule(4, 'login', 'fast')).toEqual([
      ['login', 'fast'],
      ['fast', 'login'],
      ['login', 'fast'],
      ['fast', 'login']
    ])
  })

  it('rejects counts that cannot balance launch positions', () => {
    for (const pairCount of [0, 1, 3, 4.5]) {
      expect(() => buildCounterbalancedSchedule(pairCount, 'login', 'fast')).toThrow(
        'positive even pair count'
      )
    }
  })

  it('requires distinct arms', () => {
    expect(() => buildCounterbalancedSchedule(2, 'login', 'login')).toThrow('two distinct arms')
  })

  it('gives each arm the same mean launch position', () => {
    const launches = buildCounterbalancedSchedule(20, 'login', 'fast').flat()
    const positions = { login: [], fast: [] }
    launches.forEach((arm, index) => positions[arm].push(index))

    expect(mean(positions.login)).toBe(mean(positions.fast))
  })

  it('cancels linear drift in the reported median difference', () => {
    const schedule = buildCounterbalancedSchedule(20, 'login', 'fast')
    const trueDuration = { login: 100, fast: 80 }
    const driftPerLaunch = 7
    const samples = linearDriftSamples(schedule, trueDuration, driftPerLaunch)

    const login = summarizeBenchmarkSamples(samples.login)
    const fast = summarizeBenchmarkSamples(samples.fast)
    expect(fast.medianMs - login.medianMs).toBe(trueDuration.fast - trueDuration.login)

    const lowerMedian = (values) => [...values].sort((left, right) => left - right)[9]
    expect(lowerMedian(samples.fast) - lowerMedian(samples.login)).toBe(
      trueDuration.fast - trueDuration.login - driftPerLaunch
    )
  })

  it('bounds the descriptive p95 bias to one linear-drift launch slot', () => {
    const schedule = buildCounterbalancedSchedule(20, 'login', 'fast')
    const trueDuration = { login: 100, fast: 80 }
    const driftPerLaunch = 7
    const samples = linearDriftSamples(schedule, trueDuration, driftPerLaunch)
    const login = summarizeBenchmarkSamples(samples.login)
    const fast = summarizeBenchmarkSamples(samples.fast)

    expect(fast.p95Ms - login.p95Ms).toBe(trueDuration.fast - trueDuration.login + driftPerLaunch)
    expect(BENCHMARK_SAMPLE_AGGREGATION).toEqual({
      version: 2,
      median: 'average-middle',
      p95: 'nearest-rank',
      p95Role: 'descriptive',
      p95LinearDriftBoundLaunchSlots: 1
    })
  })
})
