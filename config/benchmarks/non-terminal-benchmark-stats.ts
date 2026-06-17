import { performance } from 'node:perf_hooks'

export type TimingStats = {
  iterations: number
  meanMs: number
  medianMs: number
  p95Ms: number
  minMs: number
  maxMs: number
}

export function round(value: number): number {
  return Math.round(value * 100) / 100
}

export function stats(samples: number[]): TimingStats {
  const sorted = [...samples].sort((a, b) => a - b)
  const percentile = (p: number): number => {
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)
    return sorted.at(index) ?? 0
  }
  return {
    iterations: samples.length,
    meanMs: round(samples.reduce((total, sample) => total + sample, 0) / samples.length),
    medianMs: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    minMs: round(sorted.at(0) ?? 0),
    maxMs: round(sorted.at(-1) ?? 0)
  }
}

export function measure(iterations: number, fn: () => unknown): TimingStats {
  for (let i = 0; i < 10; i += 1) {
    fn()
  }
  const samples: number[] = []
  for (let i = 0; i < iterations; i += 1) {
    const startedAt = performance.now()
    fn()
    samples.push(performance.now() - startedAt)
  }
  return stats(samples)
}

export function formatStats(s: TimingStats): string {
  return `${s.medianMs} ms median / ${s.p95Ms} ms p95 / ${s.meanMs} ms mean (${s.iterations} iterations)`
}
