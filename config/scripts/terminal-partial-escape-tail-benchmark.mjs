#!/usr/bin/env node
// Benchmarks the partial-escape-tail fold that runs once per PTY chunk, on the main thread, for
// every terminal. Drives the production export against a baseline reproducing the pre-change
// shape (unconditional concat + per-code-unit walk), and proves equivalence over a fuzz corpus
// before timing so the gate cannot silently change what the tracker returns.
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
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
const CHUNK_BYTES = Number(process.env.ORCA_ESCAPE_TAIL_BENCH_CHUNK_BYTES ?? '16384')
const CHUNKS = Number(process.env.ORCA_ESCAPE_TAIL_BENCH_CHUNKS ?? '640')

for (const [name, value] of [
  ['ORCA_ESCAPE_TAIL_BENCH_CHUNK_BYTES', CHUNK_BYTES],
  ['ORCA_ESCAPE_TAIL_BENCH_CHUNKS', CHUNKS]
]) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`)
  }
}

const { advancePartialEscapeTail, extractPartialEscapeTail, MAX_PARTIAL_ESCAPE_TAIL_LENGTH } =
  await import(path.join(ROOT, 'src/shared/terminal-partial-escape-tail.ts'))

// Pre-change shape: always concatenate, always walk.
function baselineAdvance(pendingTail, chunk) {
  const tail = extractPartialEscapeTail(pendingTail + chunk)
  return tail.length > MAX_PARTIAL_ESCAPE_TAIL_LENGTH ? '' : tail
}

function buildChunk(bytes, { escapes }) {
  const line = escapes
    ? '\u001b[32m[build]\u001b[0m compiled src/renderer/src/components/thing.tsx in 12ms\n'
    : '[build] compiled src/renderer/src/components/thing.tsx in 12ms\n'
  let out = ''
  while (out.length < bytes) {
    out += line
  }
  return out.slice(0, bytes)
}

// Equivalence over a corpus that exercises every state the scanner can be left in, plus the
// boundaries the gate must not swallow.
const CORPUS_PIECES = [
  'plain output\n',
  '\u001b[32mgreen\u001b[0m',
  '\u001b[3',
  '\u001b]0;title\u0007',
  '\u001b]0;partial',
  '\u001bP dcs payload',
  '\u001b',
  '\u0018',
  '\u001a',
  '\u001b]8;;https://example.com\u001b\\',
  '\u001b]8;;https://example.com\u001b',
  '\u001b(B',
  '\u001b(',
  'tail without escapes',
  '\u001b[1;2;3'
]
let checked = 0
for (const pending of CORPUS_PIECES) {
  for (const chunk of CORPUS_PIECES) {
    const seedTail = extractPartialEscapeTail(pending)
    const expected = baselineAdvance(seedTail, chunk)
    const actual = advancePartialEscapeTail(seedTail, chunk)
    if (expected !== actual) {
      throw new Error(
        `gate changed the tracked tail for pending=${JSON.stringify(seedTail)} chunk=${JSON.stringify(chunk)}: ${JSON.stringify(expected)} !== ${JSON.stringify(actual)}`
      )
    }
    checked += 1
  }
}
// A long ESC-free chunk must also agree, which is the case the gate short-circuits.
const escFreeChunk = buildChunk(CHUNK_BYTES, { escapes: false })
if (baselineAdvance('', escFreeChunk) !== advancePartialEscapeTail('', escFreeChunk)) {
  throw new Error('gate disagreed with the baseline on an ESC-free chunk')
}
checked += 1

function median(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

function timeStream(advance, chunk) {
  const run = () => {
    let tail = ''
    for (let index = 0; index < CHUNKS; index += 1) {
      tail = advance(tail, chunk)
    }
    return tail
  }
  run()
  const samples = []
  for (let round = 0; round < 7; round += 1) {
    const start = performance.now()
    run()
    samples.push(performance.now() - start)
  }
  return median(samples)
}

const escapedChunk = buildChunk(CHUNK_BYTES, { escapes: true })
const megabytes = ((CHUNK_BYTES * CHUNKS) / 1024 / 1024).toFixed(1)

console.log(
  `Partial-escape-tail fold — ${CHUNKS} x ${CHUNK_BYTES / 1024} KB chunks (${megabytes} MB), ${checked} equivalence cases verified\n`
)
console.log('| stream shape | before | after | |')
console.log('| --- | --- | --- | --- |')
for (const [label, chunk] of [
  ['ESC-free (build logs, `cat`, piped output)', escFreeChunk],
  ['SGR-coloured output (gate does not apply)', escapedChunk]
]) {
  const before = timeStream(baselineAdvance, chunk)
  const after = timeStream(advancePartialEscapeTail, chunk)
  console.log(
    `| ${label} | ${before.toFixed(2)} ms | ${after.toFixed(2)} ms | ${(before / after).toFixed(1)}x |`
  )
}
