#!/usr/bin/env node
// Compare retained pane-epoch map after open→emit→close cycles with/without purge. Fresh leaf UUIDs otherwise accumulate for renderer lifetime.
import { performance } from 'node:perf_hooks'
import v8 from 'node:v8'

const CYCLES = Number.parseInt(process.env.ORCA_EPOCH_BENCH_CYCLES ?? '20000', 10)
const PANES_PER_TAB = Number.parseInt(process.env.ORCA_EPOCH_BENCH_PANES ?? '2', 10)

for (const [name, value] of [
  ['ORCA_EPOCH_BENCH_CYCLES', CYCLES],
  ['ORCA_EPOCH_BENCH_PANES', PANES_PER_TAB]
]) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${value}`)
  }
}

// Mirror production paneKey→epoch map and tab-scoped purge.
function makeActivity() {
  const outputEpochByPaneKey = new Map()
  return {
    map: outputEpochByPaneKey,
    record(paneKey) {
      outputEpochByPaneKey.set(paneKey, (outputEpochByPaneKey.get(paneKey) ?? 0) + 1)
    },
    forgetTab(tabId) {
      const prefix = `${tabId}:`
      for (const paneKey of outputEpochByPaneKey.keys()) {
        if (paneKey.startsWith(prefix)) {
          outputEpochByPaneKey.delete(paneKey)
        }
      }
    }
  }
}

// Vary UUID-shaped leaf keys per open, matching real allocation.
function leafId(index) {
  const hex = index.toString(16).padStart(12, '0').slice(-12)
  return `00000000-0000-4000-8000-${hex}`
}

function runCycles({ purge }) {
  const activity = makeActivity()
  let peak = 0
  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    const tabId = `tab-${cycle}`
    for (let pane = 0; pane < PANES_PER_TAB; pane += 1) {
      const paneKey = `${tabId}:${leafId(cycle * PANES_PER_TAB + pane)}`
      for (let chunk = 0; chunk < 8; chunk += 1) {
        activity.record(paneKey)
      }
    }
    peak = Math.max(peak, activity.map.size)
    if (purge) {
      activity.forgetTab(tabId)
    }
  }
  return { retained: activity.map.size, peak }
}

function approxRetainedBytes(entries) {
  // Conservative V8 floor ~110B/entry: ~48 UTF-16 key chars plus string header, small-int value and Map node.
  return entries * 110
}

console.log('Hibernation output-epoch map leak benchmark')
console.log(`cycles=${CYCLES} panes/tab=${PANES_PER_TAB} (open → emit 8 chunks/pane → close)\n`)

const t0 = performance.now()
const before = runCycles({ purge: false })
const afterMs = performance.now()
const after = runCycles({ purge: true })
const doneMs = performance.now()

const fmtBytes = (n) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MiB` : `${(n / 1024).toFixed(1)} KiB`

console.log('  variant         │ retained entries │ approx retained heap │ wall time')
console.log('  ────────────────┼──────────────────┼──────────────────────┼──────────')
console.log(
  `  before (leak)   │ ${String(before.retained).padStart(16)} │ ${fmtBytes(approxRetainedBytes(before.retained)).padStart(20)} │ ${(afterMs - t0).toFixed(0)} ms`
)
console.log(
  `  after  (purge)  │ ${String(after.retained).padStart(16)} │ ${fmtBytes(approxRetainedBytes(after.retained)).padStart(20)} │ ${(doneMs - afterMs).toFixed(0)} ms`
)
console.log(
  `\nWithout the purge, retained entries grow unbounded with open/close cycles` +
    ` (peak ${before.peak} ≈ ${fmtBytes(approxRetainedBytes(before.retained))}).` +
    `\nWith the purge, the map returns to ~0 after each tab closes — bounded by` +
    ` the live pane count, not session lifetime.`
)

// Serialize a representative entry to ground the per-entry estimate.
const sampleBytes = v8.serialize([`tab-0:${leafId(0)}`, 8]).byteLength
console.log(`\n(v8-serialized size of one [paneKey, epoch] entry: ${sampleBytes} bytes)`)
