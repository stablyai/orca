#!/usr/bin/env node
// Times the partial-escape-tail fold that runs once per PTY chunk for every terminal against a
// baseline with the pre-change shape (unconditional concat + per-code-unit walk). Equivalence is
// proven over a corpus first, so the reported speedup cannot come from the gate changing the answer.
import { performance } from 'node:perf_hooks'
import {
  advancePartialEscapeTail,
  extractPartialEscapeTail,
  MAX_PARTIAL_ESCAPE_TAIL_LENGTH
} from '../../src/shared/terminal-partial-escape-tail.ts'

const CHUNK_BYTES = 16 * 1024
const CHUNKS = 640
const ROUNDS = 7

function baselineAdvance(pendingTail, chunk) {
  const tail = extractPartialEscapeTail(pendingTail + chunk)
  return tail.length > MAX_PARTIAL_ESCAPE_TAIL_LENGTH ? '' : tail
}

const chunkOf = (line) => line.repeat(Math.ceil(CHUNK_BYTES / line.length)).slice(0, CHUNK_BYTES)
const escFreeChunk = chunkOf('[build] compiled src/renderer/src/components/thing.tsx in 12ms\n')
const colouredChunk = chunkOf(
  '\x1b[32m[build]\x1b[0m compiled src/renderer/src/components/thing.tsx in 12ms\n'
)

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
  escFreeChunk
]
let checked = 0
for (const pending of PIECES.map((piece) => extractPartialEscapeTail(piece))) {
  for (const chunk of PIECES) {
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

function medianMs(advance, chunk) {
  // First sample is the warm-up and is discarded.
  const samples = Array.from({ length: ROUNDS + 1 }, () => {
    const start = performance.now()
    let tail = ''
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
for (const [label, chunk] of [
  ['ESC-free (build logs, `cat`, piped output)', escFreeChunk],
  ['SGR-coloured output (gate does not apply)', colouredChunk]
]) {
  const before = medianMs(baselineAdvance, chunk)
  const after = medianMs(advancePartialEscapeTail, chunk)
  console.log(
    `| ${label} | ${before.toFixed(2)} ms | ${after.toFixed(2)} ms | ${(before / after).toFixed(1)}x |`
  )
}
