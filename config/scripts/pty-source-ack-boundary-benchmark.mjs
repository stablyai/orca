#!/usr/bin/env node
// Benchmarks relay PTY sent-boundary cleanup across a cumulative ACK drain, using the shipped
// PtySourceSentBoundaries rather than a stub so V8's real Set/array costs are included.
import { performance } from 'node:perf_hooks'
import { createJiti } from 'jiti'

const BOUNDARY_COUNTS = [1_024, 4_096, 16_384, 65_536]
// Set rehash timing swings run to run, so every row reports a median instead of a single sample.
const REPETITIONS = 3
const jiti = createJiti(import.meta.url)
const { PtySourceSentBoundaries } = await jiti.import(
  '../../src/relay/pty-source-sent-boundaries.ts'
)

// Pre-change cleanup: rescan every retained boundary on every ACK.
function fullScanDrain(count) {
  const boundaries = new Set()
  for (let boundary = 0; boundary <= count; boundary += 1) {
    boundaries.add(boundary)
  }
  const started = performance.now()
  for (let creditedEndSu = 1; creditedEndSu <= count; creditedEndSu += 1) {
    for (const boundary of boundaries) {
      if (boundary < creditedEndSu) {
        boundaries.delete(boundary)
      }
    }
  }
  return performance.now() - started
}

// Early-break cleanup: stops at the first live boundary, but still rebuilds a Set iterator per ACK.
function earlyBreakDrain(count) {
  const boundaries = new Set()
  for (let boundary = 0; boundary <= count; boundary += 1) {
    boundaries.add(boundary)
  }
  const started = performance.now()
  for (let creditedEndSu = 1; creditedEndSu <= count; creditedEndSu += 1) {
    for (const boundary of boundaries) {
      if (boundary >= creditedEndSu) {
        break
      }
      boundaries.delete(boundary)
    }
  }
  return performance.now() - started
}

// Shipped cleanup: a monotone cursor over ascending boundaries, so no boundary is ever revisited.
function cursorDrain(count) {
  const boundaries = new PtySourceSentBoundaries(0)
  for (let boundary = 1; boundary <= count; boundary += 1) {
    boundaries.add(boundary)
  }
  const started = performance.now()
  for (let creditedEndSu = 1; creditedEndSu <= count; creditedEndSu += 1) {
    boundaries.dropBelow(creditedEndSu)
  }
  return performance.now() - started
}

function medianMs(drain, count) {
  const samples = Array.from({ length: REPETITIONS }, () => drain(count)).sort((a, b) => a - b)
  return samples[(samples.length - 1) >> 1]
}

function report(count) {
  const fullScanMs = medianMs(fullScanDrain, count)
  const earlyBreakMs = medianMs(earlyBreakDrain, count)
  const cursorMs = medianMs(cursorDrain, count)
  console.log(
    `${String(count).padStart(6)} boundaries  ` +
      `full-scan ${fullScanMs.toFixed(2)}ms  ` +
      `early-break ${earlyBreakMs.toFixed(2)}ms  ` +
      `cursor ${cursorMs.toFixed(3)}ms  ` +
      `(cursor is ${(fullScanMs / cursorMs).toFixed(0)}x faster than full-scan, ` +
      `${(earlyBreakMs / cursorMs).toFixed(0)}x faster than early-break)`
  )
}

// Warm the three drains up first so the smallest row is not dominated by JIT tiering.
fullScanDrain(256)
earlyBreakDrain(256)
cursorDrain(256)

for (const count of BOUNDARY_COUNTS) {
  report(count)
}
