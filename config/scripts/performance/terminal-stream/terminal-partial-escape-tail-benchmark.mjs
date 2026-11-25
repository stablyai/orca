#!/usr/bin/env node
// Compare production per-PTY-chunk fold with unconditional concat/scan baseline; verify corpus equivalence before timing.
import { performance } from 'node:perf_hooks'
import { createJiti } from 'jiti'

const CHUNK_BYTES = 16 * 1024
const CHUNKS = 640
const ROUNDS = 7
// Use jiti: Node type stripping cannot resolve graph’s extensionless relative imports.
const jiti = createJiti(import.meta.url)
const {
  advancePartialEscapeTail,
  capPartialEscapeTail,
  extractPartialEscapeTail,
  MAX_PARTIAL_ESCAPE_TAIL_LENGTH
} = await jiti.import(
  '../../../../src/shared/terminal/protocol/escape/terminal-partial-escape-tail.ts'
)

function baselineAdvance(pendingTail, chunk) {
  return capPartialEscapeTail(extractPartialEscapeTail(pendingTail + chunk))
}

const chunkOf = (line) => line.repeat(Math.ceil(CHUNK_BYTES / line.length)).slice(0, CHUNK_BYTES)
const escFreeChunk = chunkOf('[build] compiled src/renderer/src/components/thing.tsx in 12ms\n')
const colouredChunk = chunkOf(
  '\x1b[32m[build]\x1b[0m compiled src/renderer/src/components/thing.tsx in 12ms\n'
)
const base64Chunk = chunkOf('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk')
const OPEN_INLINE_IMAGE = '\x1b]1337;File=inline=1:'
const OVER_CAP_STRINGS = [OPEN_INLINE_IMAGE + base64Chunk, `\x1bPq${base64Chunk}`]

// Every state the scanner can be left in, plus the boundaries the gate must not swallow.
const PIECES = [
  '',
  'plain output\n',
  '\x1b[32mgreen\x1b[0m',
  '\x1b[3',
  '\x1b]0;title\x07',
  '\x1b]0;partial',
  '\x1bP dcs payload',
  '\x1b',
  '\x18',
  '\x1a',
  '\x1b]8;;https://example.com\x1b\\',
  '\x1b]8;;https://example.com\x1b',
  '\x1b(B',
  '\x1b(',
  '\x1b[1;2;3',
  escFreeChunk,
  ...OVER_CAP_STRINGS
]
// oxlint-disable-next-line no-control-regex -- the C0 bytes that can end an open OSC/DCS string.
const STRING_END_BYTE = /[\x07\x18\x1a\x1b]/
const capTail = (stream) => capPartialEscapeTail(extractPartialEscapeTail(stream))
const inertTails = new Set(OVER_CAP_STRINGS.map(capTail))
let checked = 0
for (const pending of PIECES.map(capTail)) {
  for (const chunk of PIECES) {
    // On a short in-string chunk the inert tail keeps its prefix while the baseline appends the chunk;
    // xterm ignores both the same way, so compare only where the strings must match.
    const staysUnderCap = pending.length + chunk.length <= MAX_PARTIAL_ESCAPE_TAIL_LENGTH
    if (inertTails.has(pending) && staysUnderCap && !STRING_END_BYTE.test(chunk)) {
      continue
    }
    const expected = baselineAdvance(pending, chunk)
    const actual = advancePartialEscapeTail(pending, chunk)
    if (expected !== actual) {
      throw new Error(
        `gate changed the tracked tail: ${JSON.stringify({ pending, chunk, expected, actual })}`
      )
    }
    checked += 1
  }
}

function medianMs(advance, chunk, initialTail) {
  // First sample is the warm-up and is discarded.
  const samples = Array.from({ length: ROUNDS + 1 }, () => {
    const start = performance.now()
    let tail = initialTail
    for (let index = 0; index < CHUNKS; index += 1) {
      tail = advance(tail, chunk)
    }
    return performance.now() - start
  })
  return samples.slice(1).sort((left, right) => left - right)[Math.floor(ROUNDS / 2)]
}

const megabytes = ((CHUNK_BYTES * CHUNKS) / 1024 / 1024).toFixed(1)
console.log(
  `Partial-escape-tail fold: ${CHUNKS} x ${CHUNK_BYTES / 1024} KB chunks (${megabytes} MB), ${checked} equivalence cases verified\n`
)
console.log('| stream shape | before | after | |')
console.log('| --- | --- | --- | --- |')
for (const [label, chunk, initialTail] of [
  ['ESC-free (build logs, `cat`, piped output)', escFreeChunk, ''],
  ['SGR-coloured output (gate does not apply)', colouredChunk, ''],
  ['Inline image inside one open OSC 1337 (past the cap)', base64Chunk, OPEN_INLINE_IMAGE]
]) {
  const before = medianMs(baselineAdvance, chunk, initialTail)
  const after = medianMs(advancePartialEscapeTail, chunk, initialTail)
  console.log(
    `| ${label} | ${before.toFixed(2)} ms | ${after.toFixed(2)} ms | ${(before / after).toFixed(1)}x |`
  )
}
