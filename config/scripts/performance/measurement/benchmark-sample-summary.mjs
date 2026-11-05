export const BENCHMARK_SAMPLE_AGGREGATION = Object.freeze({
  version: 2,
  median: 'average-middle',
  p95: 'nearest-rank',
  p95Role: 'descriptive',
  p95LinearDriftBoundLaunchSlots: 1
})

export function summarizeBenchmarkSamples(samples) {
  if (samples.length === 0) {
    throw new Error('Benchmark samples must not be empty')
  }
  const sorted = [...samples].sort((left, right) => left - right)
  const middle = sorted.length / 2
  const median = Number.isInteger(middle)
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[Math.floor(middle)]
  const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1]

  return {
    samples: samples.length,
    medianMs: Number(median.toFixed(1)),
    p95Ms: Number(p95.toFixed(1)),
    minMs: Number(sorted[0].toFixed(1)),
    maxMs: Number(sorted.at(-1).toFixed(1))
  }
}
