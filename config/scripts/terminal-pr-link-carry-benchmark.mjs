#!/usr/bin/env node
// Benchmark: per-chunk cost of the GitHub PR-link carry scan on the PTY output path.
//
// createTerminalGitHubPRLinkDetector() runs on every PTY chunk (renderer
// pty-connection + parked-terminal-byte-watcher). Before the fix,
// getPotentialGitHubPRCarry() ran `lastIndexOf` for BOTH http scheme prefixes
// across the entire combined chunk — even on the early-out path where the chunk
// provably has no `/pull/`. The carry it returns is always a suffix of at most
// MAX_CARRY_LENGTH (512) bytes, so every byte scanned before
// `length - 512` was guaranteed-wasted work.
//
// The fix bounds the scan to that trailing window. This script measures the
// scan itself across chunk sizes so the saved work is quantified.
//
// carryBefore/carryAfter are mirrors: node cannot import the .ts source, which is
// why the sibling benchmarks in this directory inline their subject too. The
// constants below are re-read from the real module at startup so a drifted cap or
// scheme list fails loudly here instead of quietly benchmarking dead code.
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const DETECTOR_SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/shared/terminal-github-pr-link-detector.ts', import.meta.url)),
  'utf8'
)

function readMirroredConstants(source) {
  const cap = source.match(/const MAX_CARRY_LENGTH = (\d+)/)
  const prefixes = source.match(/const HTTP_SCHEME_PREFIXES = \[([^\]]+)\]/)
  if (!cap || !prefixes) {
    throw new Error(
      'terminal-github-pr-link-detector.ts no longer exposes MAX_CARRY_LENGTH / HTTP_SCHEME_PREFIXES in the expected shape; re-sync this benchmark with the implementation.'
    )
  }
  return {
    maxCarryLength: Number(cap[1]),
    httpSchemePrefixes: prefixes[1]
      .split(',')
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
  }
}

const { maxCarryLength: MAX_CARRY_LENGTH, httpSchemePrefixes: HTTP_SCHEME_PREFIXES } =
  readMirroredConstants(DETECTOR_SOURCE)
const ITERATIONS = Number.parseInt(process.env.ORCA_PR_CARRY_BENCH_ITERATIONS ?? '2000', 10)
const WARMUP = Number.parseInt(process.env.ORCA_PR_CARRY_BENCH_WARMUP ?? '200', 10)

for (const [name, value] of [
  ['ORCA_PR_CARRY_BENCH_ITERATIONS', ITERATIONS],
  ['ORCA_PR_CARRY_BENCH_WARMUP', WARMUP]
]) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${value}`)
  }
}

function hasTerminalUrlWhitespace(value, start, end) {
  for (let index = start; index < end; index += 1) {
    if (/\s/.test(value.charAt(index))) {
      return true
    }
  }
  return false
}

function endsWithHttpSchemePrefixFragment(value) {
  for (const prefix of HTTP_SCHEME_PREFIXES) {
    for (let length = Math.min(prefix.length - 1, value.length); length > 0; length--) {
      if (value.endsWith(prefix.slice(0, length))) {
        return value.slice(value.length - length)
      }
    }
  }
  return ''
}

// Pre-fix implementation, kept verbatim for comparison.
function carryBefore(value) {
  const schemeIndex = Math.max(...HTTP_SCHEME_PREFIXES.map((prefix) => value.lastIndexOf(prefix)))
  if (schemeIndex !== -1) {
    const tailLength = value.length - schemeIndex
    if (tailLength > MAX_CARRY_LENGTH) {
      return ''
    }
    return hasTerminalUrlWhitespace(value, schemeIndex, value.length)
      ? ''
      : value.slice(schemeIndex)
  }
  return endsWithHttpSchemePrefixFragment(value)
}

// Post-fix implementation, mirroring src/shared/terminal-github-pr-link-detector.ts.
function lastIndexOfHttpScheme(value, fromIndex) {
  let lastIndex = -1
  for (const prefix of HTTP_SCHEME_PREFIXES) {
    const candidate =
      fromIndex === undefined ? value.lastIndexOf(prefix) : value.lastIndexOf(prefix, fromIndex)
    if (candidate > lastIndex) {
      lastIndex = candidate
    }
  }
  return lastIndex
}

function carryAfter(value) {
  const windowStart = value.length > MAX_CARRY_LENGTH ? value.length - MAX_CARRY_LENGTH : 0
  const window = windowStart === 0 ? value : value.slice(windowStart)
  const schemeIndexInWindow = lastIndexOfHttpScheme(window)
  if (schemeIndexInWindow !== -1) {
    const schemeIndex = windowStart + schemeIndexInWindow
    return hasTerminalUrlWhitespace(value, schemeIndex, value.length)
      ? ''
      : value.slice(schemeIndex)
  }
  const fragment = endsWithHttpSchemePrefixFragment(window)
  if (fragment === '' || windowStart === 0) {
    return fragment
  }
  return lastIndexOfHttpScheme(value, windowStart - 1) === -1 ? fragment : ''
}

const GITHUB_PR_PATH_MARKER = '/pull/'

// Agent TUI output: no scheme anywhere, which is the overwhelmingly common case
// and the one where the old code scanned the full chunk to return ''. `tail`
// forces the chunk to end mid-scheme so the fallback branch is measured too.
function makeChunk(bytes, tail = '') {
  const line = 'build output line with some text and punctuation, id=12345\n'
  const filled = line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes)
  return tail ? filled.slice(0, bytes - tail.length) + tail : filled
}

// Why measure this too: the detector runs includes() over the whole chunk before
// the carry scan and the fix does not touch that cost, so timing the carry alone
// reports a win the hot path cannot actually realize. These fixtures never hold
// the marker, so this mirrors the early-out branch ordinary output takes.
function detectorEarlyOut(carry, value) {
  if (value.includes(GITHUB_PR_PATH_MARKER)) {
    throw new Error('benchmark fixture unexpectedly contains the PR marker')
  }
  return carry(value)
}

function measure(fn, chunk) {
  for (let index = 0; index < WARMUP; index += 1) {
    fn(chunk)
  }
  const samples = []
  for (let round = 0; round < 5; round += 1) {
    const start = performance.now()
    for (let index = 0; index < ITERATIONS; index += 1) {
      fn(chunk)
    }
    samples.push((performance.now() - start) / ITERATIONS)
  }
  samples.sort((a, b) => a - b)
  return samples[2]
}

// Why non-empty fixtures: a chunk of ordinary text yields '' from both versions,
// so an equality check over it would pass even for a carry that always returns ''.
const EQUIVALENCE_FIXTURES = [
  `noise ${'x'.repeat(400)}https://github.com/acme/orca/pull/7`,
  `https://github.com/acme/orca/pull/1${'x'.repeat(600)}`,
  `https://github.com/acme/orca/pull/1${'x'.repeat(600)}https`,
  `${'x'.repeat(1000)}https`,
  `${'x'.repeat(1000)}http`,
  'https://github.com/acme/orca/pull/7 trailing words',
  `${'y'.repeat(600)}`,
  '',
  'https://github.com/acme/orca/pull/7'
]
for (const fixture of EQUIVALENCE_FIXTURES) {
  if (carryBefore(fixture) !== carryAfter(fixture)) {
    throw new Error(
      `carry mismatch on fixture (len ${fixture.length}): ${JSON.stringify(carryBefore(fixture))} vs ${JSON.stringify(carryAfter(fixture))}`
    )
  }
}

const SIZES = [4 * 1024, 16 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024]
const rows = []
for (const bytes of SIZES) {
  const chunk = makeChunk(bytes)
  // 'with' ends in 'h', so the chunk terminates on a partial scheme fragment and
  // the new code pays the extra bounded probe behind the window.
  const fragmentChunk = makeChunk(bytes, 'with')
  for (const sample of [chunk, fragmentChunk]) {
    if (carryBefore(sample) !== carryAfter(sample)) {
      throw new Error(`carry mismatch at ${bytes} bytes`)
    }
  }
  rows.push({
    chunk: `${(bytes / 1024).toFixed(0)} KiB`,
    carry: measure(carryBefore, chunk) / measure(carryAfter, chunk),
    path:
      measure((value) => detectorEarlyOut(carryBefore, value), chunk) /
      measure((value) => detectorEarlyOut(carryAfter, value), chunk),
    fragment: measure(carryBefore, fragmentChunk) / measure(carryAfter, fragmentChunk)
  })
}

const pad = (value, width) => String(value).padStart(width)
console.log('PR-link carry scan, per PTY chunk. Speedup = before / after (>1 is faster).')
console.log(`iterations=${ITERATIONS} warmup=${WARMUP} (median of 5 rounds)`)
console.log(
  `${pad('chunk', 9)} ${pad('carry only', 12)} ${pad('detector path', 15)} ${pad('fragment tail', 15)}`
)
for (const row of rows) {
  console.log(
    `${pad(row.chunk, 9)} ${pad(`${row.carry.toFixed(1)}x`, 12)} ${pad(`${row.path.toFixed(1)}x`, 15)} ${pad(`${row.fragment.toFixed(2)}x`, 15)}`
  )
}
console.log(
  '\ncarry only    = the scan this change bounds, in isolation.\n' +
    'detector path = includes() + carry, i.e. what the PTY hot path actually saves.\n' +
    'fragment tail = chunk ending mid-scheme, where the new code pays an extra\n' +
    '                bounded probe. ~1x means the fallback costs nothing material.'
)
