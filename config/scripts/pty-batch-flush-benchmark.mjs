/* eslint-disable no-control-regex -- Benchmarks mirror PTY ANSI/OSC parsing regexes. */
import { performance } from 'node:perf_hooks'
import v8 from 'node:v8'

const PTY_COUNT = Number.parseInt(process.env.ORCA_PTY_BENCH_PTY_COUNT ?? '24', 10)
const PAYLOAD_CHARS = Number.parseInt(process.env.ORCA_PTY_BENCH_PAYLOAD_CHARS ?? '262144', 10)
const RUNS = Number.parseInt(process.env.ORCA_PTY_BENCH_RUNS ?? '30', 10)
const MEASURE_TIMER_DELAYS = process.env.ORCA_PTY_BENCH_MEASURE_TIMER_DELAYS !== '0'
const INGRESS_CHUNKS = Number.parseInt(process.env.ORCA_PTY_BENCH_INGRESS_CHUNKS ?? '96', 10)
const INGRESS_CHUNK_CHARS = Number.parseInt(process.env.ORCA_PTY_BENCH_INGRESS_CHARS ?? '65536', 10)
const CHUNK_CHARS = 16 * 1024
const MAX_WRITES_PER_SLICE = 2
const RECENT_PTY_OUTPUT_LIMIT = 4096
const MAX_TAIL_LINES = 2000
const MAX_TAIL_CHARS = 256 * 1024
const MAX_TAIL_PARTIAL_CHARS = 4000
const OSC_TITLE_RE = /\x1b\]([012]);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g
const URL_CANDIDATE_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi

if (!Number.isInteger(PTY_COUNT) || PTY_COUNT <= 0) {
  throw new Error(`ORCA_PTY_BENCH_PTY_COUNT must be positive, received ${PTY_COUNT}`)
}
if (!Number.isInteger(PAYLOAD_CHARS) || PAYLOAD_CHARS <= 0) {
  throw new Error(`ORCA_PTY_BENCH_PAYLOAD_CHARS must be positive, received ${PAYLOAD_CHARS}`)
}
if (!Number.isInteger(RUNS) || RUNS <= 0) {
  throw new Error(`ORCA_PTY_BENCH_RUNS must be positive, received ${RUNS}`)
}
if (!Number.isInteger(INGRESS_CHUNKS) || INGRESS_CHUNKS <= 0) {
  throw new Error(`ORCA_PTY_BENCH_INGRESS_CHUNKS must be positive, received ${INGRESS_CHUNKS}`)
}
if (!Number.isInteger(INGRESS_CHUNK_CHARS) || INGRESS_CHUNK_CHARS <= 0) {
  throw new Error(`ORCA_PTY_BENCH_INGRESS_CHARS must be positive, received ${INGRESS_CHUNK_CHARS}`)
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

function makeIngressChunk() {
  return `${'x'.repeat(INGRESS_CHUNK_CHARS - 1)}\n`
}

function extractLastOscTitleLegacy(data) {
  let last = null
  for (const m of data.matchAll(OSC_TITLE_RE)) {
    last = m[2]
  }
  return last
}

function extractLastOscTitleCurrent(data) {
  if (!data.includes('\x1b]')) {
    return null
  }
  return extractLastOscTitleLegacy(data)
}

function hasMeaningfulContentLegacy(chunk) {
  return (
    chunk
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[@-_]/g, '')
      .replace(/\u0008/g, '')
      .replace(/[^\x09\x0a\x20-\x7e]/g, '')
      .trim().length > 0
  )
}

function hasMeaningfulContentCurrent(chunk) {
  for (let index = 0; index < chunk.length; index++) {
    const code = chunk.charCodeAt(index)
    if (code === 0x1b || code < 0x09 || (code > 0x0d && code < 0x20) || code > 0x7e) {
      break
    }
    if (code > 0x20) {
      return true
    }
  }
  return hasMeaningfulContentLegacy(chunk)
}

function normalizeTerminalChunkLegacy(chunk) {
  return chunk
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\u0008/g, '')
    .replace(/[^\x09\x0a\x20-\x7e]/g, '')
}

function terminalChunkNeedsNormalization(chunk) {
  for (let index = 0; index < chunk.length; index++) {
    const code = chunk.charCodeAt(index)
    if (
      code === 0x1b ||
      code === 0x0d ||
      code < 0x09 ||
      (code > 0x0a && code < 0x20) ||
      code > 0x7e
    ) {
      return true
    }
  }
  return false
}

function normalizeTerminalChunkCurrent(chunk) {
  return terminalChunkNeedsNormalization(chunk) ? normalizeTerminalChunkLegacy(chunk) : chunk
}

function appendNormalizedToTailBuffer(previousLines, previousPartialLine, normalizedChunk) {
  if (normalizedChunk.length === 0) {
    return {
      lines: previousLines,
      partialLine: previousPartialLine
    }
  }

  const boundedPreviousPartialLine = previousPartialLine.slice(-MAX_TAIL_PARTIAL_CHARS)
  const pieces = `${boundedPreviousPartialLine}${normalizedChunk}`.split('\n')
  const nextPartialLine = (pieces.pop() ?? '').replace(/[ \t]+$/g, '')
  const retainedPartialLine = nextPartialLine.slice(-MAX_TAIL_PARTIAL_CHARS)
  let nextLines =
    pieces.length > 0
      ? [...previousLines, ...pieces.map((line) => line.replace(/[ \t]+$/g, ''))]
      : previousLines

  while (nextLines.length > MAX_TAIL_LINES) {
    nextLines.shift()
  }

  if (pieces.length > 0 || retainedPartialLine.length > previousPartialLine.length) {
    if (nextLines === previousLines) {
      nextLines = [...previousLines]
    }
    let totalChars =
      nextLines.reduce((sum, line) => sum + line.length, 0) + retainedPartialLine.length
    while (nextLines.length > 0 && totalChars > MAX_TAIL_CHARS) {
      totalChars -= nextLines.shift().length
    }
  }

  return {
    lines: nextLines,
    partialLine: retainedPartialLine
  }
}

function appendTailBufferLegacy(previousLines, previousPartialLine, chunk) {
  return appendNormalizedToTailBuffer(
    previousLines,
    previousPartialLine,
    normalizeTerminalChunkLegacy(chunk)
  )
}

function tailStateMatches(lines, partialLine, snapshot) {
  if (
    partialLine !== snapshot.partialLine ||
    lines.length !== snapshot.lines.length ||
    lines.length !== snapshot.linesTotal
  ) {
    return false
  }
  if (lines === snapshot.lines) {
    return true
  }
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] !== snapshot.lines[index]) {
      return false
    }
  }
  return true
}

class AdvertisedUrlPtyBuffer {
  raw = ''

  ingest(chunk) {
    this.raw += chunk
    if (this.raw.length > 4096) {
      this.raw = this.raw.slice(-4096)
    }
    const lastLineBreak = Math.max(this.raw.lastIndexOf('\n'), this.raw.lastIndexOf('\r'))
    if (lastLineBreak === -1) {
      return ''
    }
    const finalized = this.raw.slice(0, lastLineBreak + 1)
    this.raw = this.raw.slice(lastLineBreak + 1)
    return finalized
  }
}

function scanAdvertisedUrls(buffer, chunk) {
  const finalized = buffer.ingest(chunk)
  if (!finalized) {
    return
  }
  for (const _match of finalized.matchAll(URL_CANDIDATE_PATTERN)) {
    // Candidate extraction is enough for this benchmark; URL validation is rare
    // and only happens after a URL-shaped match.
  }
}

function measureRuntimeIngressLegacy() {
  const chunk = makeIngressChunk()
  const advertisedUrlBuffer = new AdvertisedUrlPtyBuffer()
  let recentOutput = ''
  let ptyTail = { lines: [], partialLine: '' }
  let leafTail = { lines: [], partialLine: '' }
  const start = performance.now()

  for (let index = 0; index < INGRESS_CHUNKS; index++) {
    recentOutput = `${recentOutput}${chunk}`.slice(-RECENT_PTY_OUTPUT_LIMIT)
    hasMeaningfulContentLegacy(chunk)
    extractLastOscTitleLegacy(chunk)
    scanAdvertisedUrls(advertisedUrlBuffer, chunk)
    extractLastOscTitleLegacy(chunk)
    ptyTail = appendTailBufferLegacy(ptyTail.lines, ptyTail.partialLine, chunk)
    leafTail = appendTailBufferLegacy(leafTail.lines, leafTail.partialLine, chunk)
  }

  return performance.now() - start
}

function measureRuntimeIngressCurrent() {
  const chunk = makeIngressChunk()
  const advertisedUrlBuffer = new AdvertisedUrlPtyBuffer()
  let recentOutput = ''
  let ptyTail = { lines: [], partialLine: '' }
  let leafTail = { lines: [], partialLine: '' }
  const start = performance.now()

  for (let index = 0; index < INGRESS_CHUNKS; index++) {
    recentOutput = `${recentOutput}${chunk}`.slice(-RECENT_PTY_OUTPUT_LIMIT)
    hasMeaningfulContentCurrent(chunk)
    extractLastOscTitleCurrent(chunk)
    scanAdvertisedUrls(advertisedUrlBuffer, chunk)
    extractLastOscTitleCurrent(chunk)
    const normalizedChunk = normalizeTerminalChunkCurrent(chunk)
    const ptyTailBefore = {
      lines: ptyTail.lines,
      partialLine: ptyTail.partialLine,
      linesTotal: ptyTail.lines.length
    }
    ptyTail = appendNormalizedToTailBuffer(ptyTail.lines, ptyTail.partialLine, normalizedChunk)
    leafTail = tailStateMatches(leafTail.lines, leafTail.partialLine, ptyTailBefore)
      ? { lines: ptyTail.lines, partialLine: ptyTail.partialLine }
      : appendNormalizedToTailBuffer(leafTail.lines, leafTail.partialLine, normalizedChunk)
  }

  return performance.now() - start
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
  const legacyRuntimeIngressDurations = []
  const currentRuntimeIngressDurations = []
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

    legacyRuntimeIngressDurations.push(measureRuntimeIngressLegacy())
    currentRuntimeIngressDurations.push(measureRuntimeIngressCurrent())
  }

  const legacySummary = summarize(legacyDurations)
  const boundedFirstSliceSummary = summarize(boundedFirstSliceDurations)
  const boundedMaxSliceSummary = summarize(boundedMaxSliceDurations)
  const boundedTotalSummary = summarize(boundedTotalDurations)
  const legacyInputTimerSummary = MEASURE_TIMER_DELAYS ? summarize(legacyInputTimerDelays) : null
  const boundedInputTimerSummary = MEASURE_TIMER_DELAYS ? summarize(boundedInputTimerDelays) : null
  const legacyRuntimeIngressSummary = summarize(legacyRuntimeIngressDurations)
  const currentRuntimeIngressSummary = summarize(currentRuntimeIngressDurations)

  console.log(
    JSON.stringify(
      {
        scenario: {
          ptyCount: PTY_COUNT,
          payloadChars: PAYLOAD_CHARS,
          runs: RUNS,
          totalPayloadMiB: (PTY_COUNT * PAYLOAD_CHARS) / 1024 / 1024,
          ingressChunks: INGRESS_CHUNKS,
          ingressChunkChars: INGRESS_CHUNK_CHARS,
          ingressPayloadMiB: (INGRESS_CHUNKS * INGRESS_CHUNK_CHARS) / 1024 / 1024
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
        runtimeIngress: {
          legacyRepeatedScans: legacyRuntimeIngressSummary,
          currentFastPath: currentRuntimeIngressSummary,
          estimatedReduction:
            legacyRuntimeIngressSummary.max /
            Math.max(currentRuntimeIngressSummary.max, Number.EPSILON)
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
      `runtime ingress legacy max: ${formatMs(legacyRuntimeIngressSummary.max)}`,
      `runtime ingress current max: ${formatMs(currentRuntimeIngressSummary.max)}`,
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
