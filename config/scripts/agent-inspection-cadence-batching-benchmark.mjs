#!/usr/bin/env node
// Counts how many whole-host process-table captures the agent-completion cadence costs.
//
// Local panes all resolve out of one TTL-deduped snapshot, and the inspection queue collapses
// every shared-observation task enqueued in the same tick onto a single capture. So the capture
// count is the number of DISTINCT wake instants across panes, not the number of pane wakes.
//
// This drives the production interval picker (`nextCadenceInspectionDelayMs`) against a baseline
// that reproduces the pre-change ±10% jitter, over a simulated wall-clock window.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import nodeModule from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

if (!process.execArgv.includes('--experimental-transform-types')) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', import.meta.filename],
    { stdio: 'inherit' }
  )
  process.exit(result.status ?? 1)
}

nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL)
      if (fs.existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  }
})

const ROOT = path.resolve(import.meta.dirname, '../..')
const WINDOW_MS = Number(process.env.ORCA_INSPECTION_BENCH_WINDOW_MS ?? '60000')
const PANE_COUNTS = (process.env.ORCA_INSPECTION_BENCH_PANES ?? '1,2,4,8')
  .split(',')
  .map((value) => Number(value.trim()))

if (!Number.isSafeInteger(WINDOW_MS) || WINDOW_MS <= 0) {
  throw new Error(`ORCA_INSPECTION_BENCH_WINDOW_MS must be a positive integer, got ${WINDOW_MS}`)
}
for (const paneCount of PANE_COUNTS) {
  if (!Number.isSafeInteger(paneCount) || paneCount <= 0) {
    throw new Error(`ORCA_INSPECTION_BENCH_PANES entries must be positive, got ${paneCount}`)
  }
}

const { nextCadenceInspectionDelayMs } = await import(
  path.join(ROOT, 'src/renderer/src/components/terminal-pane/agent-completion-poll-interval.ts')
)
const { POLL_TIER_INTERVAL_MS } = await import(
  path.join(ROOT, 'src/renderer/src/components/terminal-pane/agent-completion-poll-cadence.ts')
)
const { PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS } = await import(
  path.join(ROOT, 'src/shared/process-table-snapshot-reader.ts')
)

// Pre-change: independent ±10% jitter per pane, re-rolled on every reschedule.
function baselineDelayMs(baseMs) {
  return Math.round(baseMs * (1 + (Math.random() * 0.2 - 0.1)))
}

function simulate(paneCount, baseMs, pickDelay) {
  const startedAt = 1_700_000_000_000
  const wakes = []
  for (let pane = 0; pane < paneCount; pane += 1) {
    // Panes mount at arbitrary moments, which is what spreads them apart in the first place.
    let clock = startedAt + Math.floor(Math.random() * baseMs)
    while ((clock += pickDelay(baseMs, clock)) < startedAt + WINDOW_MS) {
      wakes.push(clock)
    }
  }
  // A wake is served from the snapshot the previous capture produced until that snapshot's TTL
  // lapses, so the TTL window starts at the capture, not on an epoch grid.
  let captures = 0
  let snapshotExpiresAt = -Infinity
  for (const wakeAt of wakes.sort((left, right) => left - right)) {
    if (wakeAt >= snapshotExpiresAt) {
      captures += 1
      snapshotExpiresAt = wakeAt + PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS
    }
  }
  return captures
}

function medianOf(rounds, run) {
  const samples = Array.from({ length: rounds }, run).sort((left, right) => left - right)
  return samples[Math.floor(samples.length / 2)]
}

const baseMs = POLL_TIER_INTERVAL_MS.idle
console.log(
  `Agent-completion cadence — whole-host \`ps\` captures over ${WINDOW_MS / 1000}s at the idle tier (${baseMs}ms)\n`
)
console.log('| visible panes | before | after | reduction |')
console.log('| --- | --- | --- | --- |')
for (const paneCount of PANE_COUNTS) {
  const before = medianOf(21, () => simulate(paneCount, baseMs, baselineDelayMs))
  const after = medianOf(21, () =>
    simulate(paneCount, baseMs, (base, now) =>
      nextCadenceInspectionDelayMs({
        baseMs: base,
        hasConsecutiveErrors: false,
        alignToSharedGrid: true,
        now
      })
    )
  )
  // A window shorter than one cadence tier can leave the baseline at zero; reporting a
  // percentage off that divides by zero and prints a meaningless reduction.
  const reduction = before > 0 ? `${(((before - after) / before) * 100).toFixed(0)}%` : 'n/a'
  console.log(`| ${paneCount} | ${before} | ${after} | ${reduction} |`)
}

// Detection latency must not regress: the grid deadline is always within one interval.
let worstDelay = 0
for (let sample = 0; sample < 100_000; sample += 1) {
  const now = 1_700_000_000_000 + sample * 7
  worstDelay = Math.max(
    worstDelay,
    nextCadenceInspectionDelayMs({
      baseMs,
      hasConsecutiveErrors: false,
      alignToSharedGrid: true,
      now
    })
  )
}
if (worstDelay > baseMs) {
  throw new Error(`grid alignment delayed a poll to ${worstDelay}ms, above the ${baseMs}ms tier`)
}
console.log(
  `\nWorst observed wait: ${worstDelay}ms (tier interval ${baseMs}ms) — no inspection is ever delayed.`
)
