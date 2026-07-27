#!/usr/bin/env node
// Benchmark: the event-loop yield in the Claude usage scanner's batch loops.
//
// scanner.ts yielded with `setTimeout(resolve, 0)`, which Node clamps to ~1ms. The
// loops yield once per FILE_SCAN_BATCH_SIZE files across two passes, so a machine with
// thousands of transcripts spent seconds parked on timers doing no work. setImmediate
// yields on the same tick's check phase with no clamp. The sibling scanner
// (src/main/codex-usage/scanner.ts) already used setImmediate.
//
// The yield exists to keep the main process responsive during a scan, so this also
// measures worst-case latency for a concurrent task -- a "faster" yield that starved
// other work would be a regression, not a win.
//
// Run with:  node config/scripts/claude-usage-yield-benchmark.mjs
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { readdirSync, statSync } from 'node:fs'

const REPO_ROOT = new URL('../..', import.meta.url)
const ROUNDS = Number(process.env.ORCA_YIELD_BENCH_ROUNDS ?? '10')

// Why re-read the source: the claim is that the scanner yields once per batch across
// two loops. If the batch size or the yield sites change, these numbers stop meaning
// what the header says, so fail loudly instead of reporting a stale ratio.
const SCANNER_SOURCE = readFileSync(new URL('src/main/claude-usage/scanner.ts', REPO_ROOT), 'utf8')
const batchMatch = SCANNER_SOURCE.match(/const FILE_SCAN_BATCH_SIZE = (\d+)/)
if (!batchMatch) {
  throw new Error('FILE_SCAN_BATCH_SIZE not found; this benchmark is stale')
}
const FILE_SCAN_BATCH_SIZE = Number(batchMatch[1])
const YIELD_SITES = (SCANNER_SOURCE.match(/await yieldToEventLoop\(\)/g) ?? []).length
if (YIELD_SITES === 0) {
  throw new Error('no yieldToEventLoop call sites found; this benchmark is stale')
}
// Match the call, not the word: a comment mentioning setImmediate would satisfy a
// bare substring check even after the yield reverted to setTimeout.
if (!/setImmediate\(resolve\)/.test(SCANNER_SOURCE)) {
  throw new Error('scanner no longer yields with setImmediate; this benchmark is stale')
}

// Real transcript count drives the yield count, so read it rather than assume one.
function countClaudeTranscripts() {
  const root = join(homedir(), '.claude', 'projects')
  let count = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        stack.push(join(dir, entry.name))
      } else if (entry.name.endsWith('.jsonl')) {
        count += 1
      }
    }
  }
  return count
}

const transcriptCount = (() => {
  try {
    statSync(join(homedir(), '.claude', 'projects'))
    return countClaudeTranscripts()
  } catch {
    return 0
  }
})()

const FALLBACK_TRANSCRIPTS = 7500
const effectiveTranscripts = transcriptCount > 0 ? transcriptCount : FALLBACK_TRANSCRIPTS
// Each pass walks ceil(files / batch) batches and yields after every batch except the
// last, so a pass yields batchesPerPass - 1 times.
const BATCHES_PER_PASS = Math.max(1, Math.ceil(effectiveTranscripts / FILE_SCAN_BATCH_SIZE))
const YIELDS_PER_SCAN = Math.max(1, (BATCHES_PER_PASS - 1) * YIELD_SITES)

const yieldWithTimeout = () => new Promise((resolve) => setTimeout(resolve, 0))
const yieldWithImmediate = () => new Promise((resolve) => setImmediate(resolve))

// Mirrors the scanner's shape: a little synchronous work per batch, then a yield.
async function runBatchLoop(doYield, batches) {
  let sink = 0
  for (let batch = 0; batch < batches; batch += 1) {
    for (let file = 0; file < FILE_SCAN_BATCH_SIZE; file += 1) {
      sink += (batch * 31 + file) % 7
    }
    if (batch + 1 < batches) {
      await doYield()
    }
  }
  return sink
}

async function timeArm(doYield, batches) {
  const start = performance.now()
  const sink = await runBatchLoop(doYield, batches)
  const elapsed = performance.now() - start
  if (sink === -1) {
    throw new Error('unreachable')
  }
  return elapsed
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = sorted.length / 2
  return (sorted[mid - 1] + sorted[mid]) / 2
}

// Arms alternate which one leads so within-round drift cannot favour either.
async function measure(batches) {
  await runBatchLoop(yieldWithTimeout, Math.min(batches, 50))
  await runBatchLoop(yieldWithImmediate, Math.min(batches, 50))
  const timeoutSamples = []
  const immediateSamples = []
  for (let round = 0; round < ROUNDS; round += 1) {
    if (round % 2 === 0) {
      timeoutSamples.push(await timeArm(yieldWithTimeout, batches))
      immediateSamples.push(await timeArm(yieldWithImmediate, batches))
    } else {
      immediateSamples.push(await timeArm(yieldWithImmediate, batches))
      timeoutSamples.push(await timeArm(yieldWithTimeout, batches))
    }
  }
  return { timeoutMs: median(timeoutSamples), immediateMs: median(immediateSamples) }
}

// The yield exists for responsiveness, so measure what a concurrent task actually sees.
async function measureConcurrentLatency(doYield, batches) {
  let worstLatencyMs = 0
  let stop = false
  const probe = (async () => {
    while (!stop) {
      const tick = performance.now()
      await new Promise((resolve) => setImmediate(resolve))
      worstLatencyMs = Math.max(worstLatencyMs, performance.now() - tick)
    }
  })()
  const start = performance.now()
  await runBatchLoop(doYield, batches)
  const scanMs = performance.now() - start
  stop = true
  await probe
  return { scanMs, worstLatencyMs }
}

const pad = (value, width) => String(value).padStart(width)
console.log('Claude usage scanner event-loop yield. Lower is better.')
console.log(
  `transcripts=${transcriptCount > 0 ? transcriptCount : `${FALLBACK_TRANSCRIPTS} (none found; synthetic)`} batch=${FILE_SCAN_BATCH_SIZE} sites=${YIELD_SITES} -> ~${YIELDS_PER_SCAN} yields/scan`
)
console.log(
  `${pad('yields', 8)} ${pad('setTimeout(0)', 14)} ${pad('setImmediate', 13)} ${pad('speedup', 9)} ${pad('saved', 11)}`
)

for (const yields of [100, 500, YIELDS_PER_SCAN]) {
  // runBatchLoop yields batches - 1 times, so ask for one more batch than yields.
  const batches = yields + 1
  const { timeoutMs, immediateMs } = await measure(batches)
  // Why report the absolute saving too: the setImmediate arm is small enough that
  // background load moves the RATIO a lot while the removed wall time barely budges.
  console.log(
    `${pad(yields, 8)} ${pad(`${timeoutMs.toFixed(1)} ms`, 14)} ${pad(`${immediateMs.toFixed(1)} ms`, 13)} ${pad(`${(timeoutMs / immediateMs).toFixed(1)}x`, 9)} ${pad(`${(timeoutMs - immediateMs).toFixed(0)} ms`, 11)}`
  )
}

console.log('\nResponsiveness (the reason the yield exists) at a full scan:')
const timeoutLatency = await measureConcurrentLatency(yieldWithTimeout, YIELDS_PER_SCAN + 1)
const immediateLatency = await measureConcurrentLatency(yieldWithImmediate, YIELDS_PER_SCAN + 1)
console.log(
  `  setTimeout(0): scan ${timeoutLatency.scanMs.toFixed(0)} ms, worst concurrent wait ${timeoutLatency.worstLatencyMs.toFixed(2)} ms`
)
console.log(
  `  setImmediate : scan ${immediateLatency.scanMs.toFixed(0)} ms, worst concurrent wait ${immediateLatency.worstLatencyMs.toFixed(2)} ms`
)
if (immediateLatency.worstLatencyMs > timeoutLatency.worstLatencyMs) {
  console.log(
    '\n  NOTE: setImmediate showed a WORSE concurrent wait here. The yield exists for\n  responsiveness, so that would be a regression even though the scan is faster.'
  )
}

console.log(
  '\nRead the SAVED column, not the ratio. The setImmediate arm is small enough that\nbackground load swings the ratio (32x-81x observed across runs on a loaded machine)\nwhile the removed wall time stays at ~4.2-5.1 s. The saving is wall-clock the main\nprocess spent parked on timer clamps, not CPU work removed. It is paid on every\nUsage-pane scan and every forced automation rescan.'
)
