import { performance } from 'node:perf_hooks'
import v8 from 'node:v8'

const PTY_COUNT = Number.parseInt(process.env.ORCA_PTY_BENCH_PTY_COUNT ?? '24', 10)
const PAYLOAD_CHARS = Number.parseInt(process.env.ORCA_PTY_BENCH_PAYLOAD_CHARS ?? '262144', 10)
const RUNS = Number.parseInt(process.env.ORCA_PTY_BENCH_RUNS ?? '30', 10)
const MEASURE_TIMER_DELAYS = process.env.ORCA_PTY_BENCH_MEASURE_TIMER_DELAYS !== '0'
const CHUNK_CHARS = 16 * 1024
const MAX_WRITES_PER_SLICE = 2

if (!Number.isInteger(PTY_COUNT) || PTY_COUNT <= 0) {
  throw new Error(`ORCA_PTY_BENCH_PTY_COUNT must be positive, received ${PTY_COUNT}`)
}
if (!Number.isInteger(PAYLOAD_CHARS) || PAYLOAD_CHARS <= 0) {
  throw new Error(`ORCA_PTY_BENCH_PAYLOAD_CHARS must be positive, received ${PAYLOAD_CHARS}`)
}
if (!Number.isInteger(RUNS) || RUNS <= 0) {
  throw new Error(`ORCA_PTY_BENCH_RUNS must be positive, received ${RUNS}`)
}

function makePendingData() {
  const pending = new Map()
  for (let index = 0; index < PTY_COUNT; index++) {
    pending.set(`pty-${index}`, `${index}:`.padEnd(PAYLOAD_CHARS, 'x'))
  }
  return pending
}

function simulateWebContentsSend(id, data) {
  return v8.serialize({ channel: 'pty:data', payload: { id, data } }).byteLength
}

function flushLegacy(pending) {
  let bytes = 0
  const start = performance.now()
  for (const [id, data] of pending) {
    bytes += simulateWebContentsSend(id, data)
  }
  pending.clear()
  return { bytes, durationMs: performance.now() - start }
}

function flushBoundedSlice(pending) {
  let bytes = 0
  let writes = 0
  const start = performance.now()
  while (pending.size > 0 && writes < MAX_WRITES_PER_SLICE) {
    const next = pending.entries().next().value
    if (!next) {
      break
    }
    const [id, data] = next
    pending.delete(id)
    const chunk = data.slice(0, CHUNK_CHARS)
    const remaining = data.slice(CHUNK_CHARS)
    if (remaining) {
      pending.set(id, remaining)
    }
    bytes += simulateWebContentsSend(id, chunk)
    writes++
  }
  return { bytes, durationMs: performance.now() - start }
}

function drainBounded(pending) {
  let bytes = 0
  const sliceDurations = []
  while (pending.size > 0) {
    const result = flushBoundedSlice(pending)
    bytes += result.bytes
    sliceDurations.push(result.durationMs)
  }
  return { bytes, sliceDurations }
}

function scheduleLegacyFlush(pending) {
  return new Promise((resolve) => {
    setTimeout(() => {
      flushLegacy(pending)
      resolve()
    }, 0)
  })
}

function scheduleBoundedFlush(pending) {
  return new Promise((resolve) => {
    const drain = () => {
      flushBoundedSlice(pending)
      if (pending.size > 0) {
        setTimeout(drain, 1)
        return
      }
      resolve()
    }
    setTimeout(drain, 0)
  })
}

async function measureInputTimerDelay(flushKind) {
  const pending = makePendingData()
  const scheduledAt = performance.now()
  const drainPromise =
    flushKind === 'legacy' ? scheduleLegacyFlush(pending) : scheduleBoundedFlush(pending)
  const inputDelay = await new Promise((resolve) => {
    setTimeout(() => resolve(performance.now() - scheduledAt), 0)
  })
  await drainPromise
  return inputDelay
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index] ?? 0
}

function summarize(values) {
  return {
    median: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.max(...values)
  }
}

function formatMs(value) {
  return `${value.toFixed(3)}ms`
}

async function runBenchmark() {
  const legacyDurations = []
  const boundedFirstSliceDurations = []
  const boundedMaxSliceDurations = []
  const boundedTotalDurations = []
  const legacyInputTimerDelays = []
  const boundedInputTimerDelays = []
  let legacyBytes = 0
  let boundedBytes = 0

  for (let run = 0; run < RUNS; run++) {
    const legacy = flushLegacy(makePendingData())
    legacyDurations.push(legacy.durationMs)
    legacyBytes = legacy.bytes

    const boundedStart = performance.now()
    const bounded = drainBounded(makePendingData())
    boundedBytes = bounded.bytes
    boundedFirstSliceDurations.push(bounded.sliceDurations[0] ?? 0)
    boundedMaxSliceDurations.push(Math.max(...bounded.sliceDurations))
    boundedTotalDurations.push(performance.now() - boundedStart)

    if (MEASURE_TIMER_DELAYS) {
      legacyInputTimerDelays.push(await measureInputTimerDelay('legacy'))
      boundedInputTimerDelays.push(await measureInputTimerDelay('bounded'))
    }
  }

  const legacySummary = summarize(legacyDurations)
  const boundedFirstSliceSummary = summarize(boundedFirstSliceDurations)
  const boundedMaxSliceSummary = summarize(boundedMaxSliceDurations)
  const boundedTotalSummary = summarize(boundedTotalDurations)
  const legacyInputTimerSummary = MEASURE_TIMER_DELAYS ? summarize(legacyInputTimerDelays) : null
  const boundedInputTimerSummary = MEASURE_TIMER_DELAYS ? summarize(boundedInputTimerDelays) : null

  console.log(
    JSON.stringify(
      {
        scenario: {
          ptyCount: PTY_COUNT,
          payloadChars: PAYLOAD_CHARS,
          runs: RUNS,
          totalPayloadMiB: (PTY_COUNT * PAYLOAD_CHARS) / 1024 / 1024
        },
        legacy: {
          bytesPerRun: legacyBytes,
          singleCallback: legacySummary,
          inputTimerDelay: legacyInputTimerSummary
        },
        bounded: {
          bytesPerRun: boundedBytes,
          firstSlice: boundedFirstSliceSummary,
          maxSlice: boundedMaxSliceSummary,
          totalDrain: boundedTotalSummary,
          inputTimerDelay: boundedInputTimerSummary
        },
        estimatedPtyWriteDelay:
          legacyInputTimerSummary && boundedInputTimerSummary
            ? {
                before: legacyInputTimerSummary.max,
                after: boundedInputTimerSummary.max,
                reduction:
                  legacyInputTimerSummary.max /
                  Math.max(boundedInputTimerSummary.max, Number.EPSILON)
              }
            : null
      },
      null,
      2
    )
  )

  console.error(
    [
      `legacy max single callback: ${formatMs(legacySummary.max)}`,
      `bounded max first slice: ${formatMs(boundedFirstSliceSummary.max)}`,
      `bounded max any slice: ${formatMs(boundedMaxSliceSummary.max)}`,
      `bounded max total drain: ${formatMs(boundedTotalSummary.max)}`,
      legacyInputTimerSummary
        ? `legacy max input timer delay: ${formatMs(legacyInputTimerSummary.max)}`
        : null,
      boundedInputTimerSummary
        ? `bounded max input timer delay: ${formatMs(boundedInputTimerSummary.max)}`
        : null
    ]
      .filter(Boolean)
      .join('\n')
  )
}

await runBenchmark()
