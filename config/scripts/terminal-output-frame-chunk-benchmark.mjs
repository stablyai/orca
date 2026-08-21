#!/usr/bin/env node
// Benchmark: iterateTerminalOutputFrameChunks, which every byte of remote terminal
// output passes through on its way to a mobile/remote-desktop multiplex stream.
//
// The pre-fix loop was `for (const part of data)`: V8 materializes a fresh 1-2 code
// unit string per code point, then measureClipboardTextByteLength re-walked that
// string through codePointAt to get its UTF-8 width, and the chunk was rebuilt with
// `chunk += part`. The gate in front of it (terminalStreamByteLengthExceeds) ran the
// same per-code-point walk over the whole payload a second time.
//
// The fix: one charCodeAt scan computing UTF-8 width inline, slices for chunk text,
// and bounded byte probes when UTF-16 length alone cannot prove fit or overflow.
//
// BOTH arms run the complete production path, encodeTerminalStreamText included, and
// their emitted frames (base64 + seq + opcode) are compared before any timing, so an
// arm that split differently or renumbered a seq cannot be reported as a win.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import nodeModule from 'node:module'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

// terminal-stream-protocol.ts declares a TS enum, which Node's default strip-only
// loader rejects; re-exec once with type transformation rather than re-modelling
// the opcodes here (a hand copy could drift from the wire contract).
if (!process.execArgv.includes('--experimental-transform-types')) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', import.meta.filename],
    { stdio: 'inherit' }
  )
  process.exit(result.status ?? 1)
}

// The app's TS sources import siblings without an extension; Node's ESM resolver needs it.
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL)
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  }
})

const ITERATIONS = Number(process.env.ORCA_FRAME_CHUNK_BENCH_ITERATIONS ?? '40')
const GATE_ITERATIONS = Number(process.env.ORCA_FRAME_GATE_BENCH_ITERATIONS ?? '2000')
const WARMUP = Number(process.env.ORCA_FRAME_CHUNK_BENCH_WARMUP ?? '8')
const ROUNDS = Number(process.env.ORCA_FRAME_CHUNK_BENCH_ROUNDS ?? '6')

for (const [name, value] of [
  ['ORCA_FRAME_CHUNK_BENCH_ITERATIONS', ITERATIONS],
  ['ORCA_FRAME_GATE_BENCH_ITERATIONS', GATE_ITERATIONS],
  ['ORCA_FRAME_CHUNK_BENCH_WARMUP', WARMUP],
  ['ORCA_FRAME_CHUNK_BENCH_ROUNDS', ROUNDS]
]) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${value}`)
  }
}
if (ROUNDS % 2 !== 0) {
  throw new Error(`ORCA_FRAME_CHUNK_BENCH_ROUNDS must be even so each arm leads equally`)
}

const CHUNK_SOURCE = readFileSync(
  new URL('../../src/main/runtime/rpc/terminal-output-frame-chunks.ts', import.meta.url),
  'utf8'
)
const CLIPBOARD_SOURCE = readFileSync(
  new URL('../../src/shared/clipboard-text.ts', import.meta.url),
  'utf8'
)

// Match executable source markers so a stale benchmark fails instead of misleading.
for (const [source, label, marker] of [
  [
    CHUNK_SOURCE,
    'terminal-output-frame-chunks.ts',
    'export function exceedsTerminalStreamChunkBytes(data: string): boolean'
  ],
  [CHUNK_SOURCE, 'terminal-output-frame-chunks.ts', 'TERMINAL_STREAM_BYTE_PROBE_CODE_UNITS'],
  [
    CHUNK_SOURCE,
    'terminal-output-frame-chunks.ts',
    'terminalStreamByteLength(data.slice(start, end))'
  ],
  [CHUNK_SOURCE, 'terminal-output-frame-chunks.ts', 'const text = data.slice(chunkStart, end)'],
  [CHUNK_SOURCE, 'terminal-output-frame-chunks.ts', 'data.charCodeAt(index + 1)'],
  [CLIPBOARD_SOURCE, 'clipboard-text.ts', 'export function measureClipboardTextByteLength('],
  [CLIPBOARD_SOURCE, 'clipboard-text.ts', 'text.codePointAt(index)']
]) {
  if (!source.includes(marker)) {
    throw new Error(`${label} no longer contains \`${marker}\`; this benchmark is stale`)
  }
}
if (CHUNK_SOURCE.includes('for (const part of data)')) {
  throw new Error(
    'terminal-output-frame-chunks.ts still iterates code points as strings; this benchmark is stale'
  )
}

const { TERMINAL_STREAM_CHUNK_BYTES } = await import(
  new URL('../../src/shared/terminal-multiplex-flow-control.ts', import.meta.url).href
)
const { measureClipboardTextByteLength } = await import(
  new URL('../../src/shared/clipboard-text.ts', import.meta.url).href
)
const { TerminalStreamOpcode, encodeTerminalStreamJson, encodeTerminalStreamText } = await import(
  new URL('../../src/shared/terminal-stream-protocol.ts', import.meta.url).href
)
const { exceedsTerminalStreamChunkBytes, iterateTerminalOutputFrameChunks } = await import(
  new URL('../../src/main/runtime/rpc/terminal-output-frame-chunks.ts', import.meta.url).href
)

function previousGate(data) {
  return (
    data.length > TERMINAL_STREAM_CHUNK_BYTES ||
    Buffer.byteLength(data, 'utf8') > TERMINAL_STREAM_CHUNK_BYTES
  )
}

// Pre-fix arm: the exact code that shipped, including the second full walk in the gate.
function* iterateBefore(data, meta) {
  const rawLength = meta?.rawLength ?? data.length
  if (meta?.transformed || rawLength !== data.length) {
    yield {
      opcode: TerminalStreamOpcode.OutputSpan,
      bytes: encodeTerminalStreamJson({ data, rawLength, transformed: true }),
      seq: meta?.seq
    }
    return
  }
  if (
    !measureClipboardTextByteLength(data, { stopAfterBytes: TERMINAL_STREAM_CHUNK_BYTES })
      .exceededLimit
  ) {
    yield { bytes: encodeTerminalStreamText(data), seq: meta?.seq }
    return
  }
  const canPreserveChunkSeq = typeof meta?.seq === 'number' && rawLength === data.length
  const shouldDelayFinalSeq = !canPreserveChunkSeq && typeof meta?.seq === 'number'
  const startSeq = canPreserveChunkSeq ? meta.seq - rawLength : undefined
  let chunk = ''
  let chunkBytes = 0
  let chunkStartOffset = 0
  let offset = 0
  let delayedChunk = null

  const takeChunk = () => {
    if (!chunk) {
      return null
    }
    const chunkSeq = canPreserveChunkSeq ? startSeq + chunkStartOffset + chunk.length : undefined
    const current = { text: chunk, seq: chunkSeq }
    chunk = ''
    chunkBytes = 0
    chunkStartOffset = offset
    return current
  }

  for (const part of data) {
    const partBytes = measureClipboardTextByteLength(part).byteLength
    if (chunkBytes > 0 && chunkBytes + partBytes > TERMINAL_STREAM_CHUNK_BYTES) {
      const nextChunk = takeChunk()
      if (nextChunk) {
        if (shouldDelayFinalSeq) {
          if (delayedChunk) {
            yield { bytes: encodeTerminalStreamText(delayedChunk.text) }
          }
          delayedChunk = nextChunk
        } else {
          yield { bytes: encodeTerminalStreamText(nextChunk.text), seq: nextChunk.seq }
        }
      }
    }
    chunk += part
    chunkBytes += partBytes
    offset += part.length
  }
  const finalChunk = takeChunk()
  if (shouldDelayFinalSeq) {
    if (finalChunk) {
      if (delayedChunk) {
        yield { bytes: encodeTerminalStreamText(delayedChunk.text) }
      }
      delayedChunk = finalChunk
    }
    if (delayedChunk) {
      yield { bytes: encodeTerminalStreamText(delayedChunk.text), seq: meta.seq }
    }
    return
  }
  if (finalChunk) {
    yield { bytes: encodeTerminalStreamText(finalChunk.text), seq: finalChunk.seq }
  }
}

// The multiplex stream consumes every frame's bytes/seq/opcode; charge both arms for it.
let frameChecksum = 0
function drain(iterate, data, meta) {
  let frames = 0
  let bytes = 0
  let seqSum = 0
  for (const frame of iterate(data, meta)) {
    frames += 1
    bytes += frame.bytes.byteLength
    seqSum += frame.seq ?? 0
  }
  frameChecksum = Math.imul(frameChecksum ^ (frames + bytes + seqSum), 16777619) >>> 0
  return frames
}

function describeFrames(iterate, data, meta) {
  const shapes = []
  for (const frame of iterate(data, meta)) {
    shapes.push(
      `${Buffer.from(frame.bytes).toString('base64')}|${frame.seq ?? 'u'}|${frame.opcode ?? 'u'}`
    )
  }
  return shapes.join('\n')
}

const SURROGATE_PAIR = '\u{1f600}'
const LONE_HIGH = '\ud83d'

function repeatTo(unit, codeUnits) {
  let out = ''
  while (out.length < codeUnits) {
    out += unit
  }
  return out.slice(0, out.length - (out.length % unit.length))
}

// A realistic agent-TUI line: SGR runs, a wide glyph, a currency sign, an emoji.
const TUI_LINE =
  '\u001b[35m\u273b Thinking\u001b[0m about the \u20ac plan \u{1f600} 42 passed, 0 failed\r\n'

const fixtures = [
  {
    label: 'ascii 4KiB (typical batch)',
    data: 'x'.repeat(4 * 1024),
    meta: (data) => ({ seq: 5_000_000, rawLength: data.length })
  },
  {
    label: `ascii ${TERMINAL_STREAM_CHUNK_BYTES}B (at cap)`,
    data: 'x'.repeat(TERMINAL_STREAM_CHUNK_BYTES),
    meta: (data) => ({ seq: 5_000_000, rawLength: data.length })
  },
  {
    label: 'ascii 64KiB (batch cap, 2 chunks)',
    data: 'x'.repeat(64 * 1024),
    meta: (data) => ({ seq: 5_000_000, rawLength: data.length })
  },
  {
    label: 'mixed TUI 64KiB (2 chunks)',
    data: repeatTo(TUI_LINE, 64 * 1024),
    meta: (data) => ({ seq: 5_000_000, rawLength: data.length })
  },
  {
    // seq without an explicit rawLength: the batcher's ordinary shape.
    label: 'mixed TUI 64KiB (implicit raw)',
    data: repeatTo(TUI_LINE, 64 * 1024),
    meta: () => ({ seq: 5_000_000 })
  },
  {
    label: 'emoji 64KiB (4-byte, 2 chunks)',
    data: repeatTo(SURROGATE_PAIR, 32 * 1024),
    meta: (data) => ({ seq: 5_000_000, rawLength: data.length })
  },
  {
    label: 'lone surrogates 64KiB',
    data: repeatTo(LONE_HIGH, 64 * 1024),
    meta: (data) => ({ seq: 5_000_000, rawLength: data.length })
  },
  {
    label: 'late-wide gate miss (3 chunks)',
    data: `${'a'.repeat(16_000)}${'\u20ac'.repeat(32_000)}`,
    meta: (data) => ({ seq: 5_000_000, rawLength: data.length })
  },
  {
    label: 'ascii 512KiB (snapshot chunking)',
    data: 'x'.repeat(512 * 1024),
    meta: () => undefined
  }
]

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

// Why interleaved with an alternating lead: running one arm's whole batch first lets
// CPU frequency drift correlate with whichever arm is being measured. Elsewhere in this
// effort that alone reported 23.3x for a real 6.7x.
function measureInterleaved(data, meta) {
  for (let index = 0; index < WARMUP; index += 1) {
    drain(iterateBefore, data, meta)
    drain(iterateTerminalOutputFrameChunks, data, meta)
  }
  const beforeSamples = []
  const afterSamples = []
  for (let round = 0; round < ROUNDS; round += 1) {
    const runBefore = () => {
      const start = performance.now()
      for (let index = 0; index < ITERATIONS; index += 1) {
        drain(iterateBefore, data, meta)
      }
      beforeSamples.push((performance.now() - start) / ITERATIONS)
    }
    const runAfter = () => {
      const start = performance.now()
      for (let index = 0; index < ITERATIONS; index += 1) {
        drain(iterateTerminalOutputFrameChunks, data, meta)
      }
      afterSamples.push((performance.now() - start) / ITERATIONS)
    }
    if (round % 2 === 0) {
      runBefore()
      runAfter()
    } else {
      runAfter()
      runBefore()
    }
  }
  return { beforeMs: median(beforeSamples), afterMs: median(afterSamples) }
}

let gateChecksum = 0

function drainGate(gate, data) {
  gateChecksum = Math.imul(gateChecksum ^ (gate(data) ? 1 : 0), 16777619) >>> 0
}

function measureGateInterleaved(data) {
  for (let index = 0; index < WARMUP * 10; index += 1) {
    drainGate(previousGate, data)
    drainGate(exceedsTerminalStreamChunkBytes, data)
  }
  const previousSamples = []
  const boundedSamples = []
  for (let round = 0; round < ROUNDS; round += 1) {
    const run = (gate, samples) => {
      const start = performance.now()
      for (let index = 0; index < GATE_ITERATIONS; index += 1) {
        drainGate(gate, data)
      }
      samples.push((performance.now() - start) / GATE_ITERATIONS)
    }
    if (round % 2 === 0) {
      run(previousGate, previousSamples)
      run(exceedsTerminalStreamChunkBytes, boundedSamples)
    } else {
      run(exceedsTerminalStreamChunkBytes, boundedSamples)
      run(previousGate, previousSamples)
    }
  }
  return { previousMs: median(previousSamples), boundedMs: median(boundedSamples) }
}

const pad = (value, width) => String(value).padStart(width)
console.log('iterateTerminalOutputFrameChunks, per flushed batch. Lower is better.')
console.log(
  `iterations=${ITERATIONS} warmup=${WARMUP} rounds=${ROUNDS} (alternating lead, per-arm median)`
)
console.log(
  `${pad('fixture', 34)} ${pad('frames', 7)} ${pad('per-part', 11)} ${pad('scanned', 11)} ${pad('speedup', 9)}`
)

let comparedFixtures = 0
for (const fixture of fixtures) {
  const meta = fixture.meta(fixture.data)
  const before = describeFrames(iterateBefore, fixture.data, meta)
  const after = describeFrames(iterateTerminalOutputFrameChunks, fixture.data, meta)
  if (before !== after) {
    throw new Error(`frames differ for ${fixture.label}`)
  }
  const frames = before.split('\n').length
  // Guard against a fixture that never reaches the chunking loop; then both arms would
  // just be measuring the gate and the comparison above would prove nothing about it.
  if (fixture.data.length > TERMINAL_STREAM_CHUNK_BYTES && frames < 2) {
    throw new Error(`${fixture.label} never split; fixture does not exercise the chunk loop`)
  }
  comparedFixtures += 1
  const { beforeMs, afterMs } = measureInterleaved(fixture.data, meta)
  console.log(
    `${pad(fixture.label, 34)} ${pad(frames, 7)} ${pad(`${beforeMs.toFixed(3)} ms`, 11)} ${pad(`${afterMs.toFixed(3)} ms`, 11)} ${pad(`${(beforeMs / afterMs).toFixed(1)}x`, 9)}`
  )
}

console.log(
  `\nvalidated=${comparedFixtures} fixtures frame-identical before timing, checksum=${frameChecksum >>> 0}`
)
const gateFixtures = [
  { label: 'ascii 4KiB fit proof', data: 'x'.repeat(4 * 1024) },
  {
    label: 'three-byte exact-cap fit proof',
    data: '\u20ac'.repeat(TERMINAL_STREAM_CHUNK_BYTES / 3)
  },
  {
    label: 'late-wide fit after probes',
    data: `${'a'.repeat(16_000)}${'\u20ac'.repeat(11_000)}`
  },
  {
    label: 'late-wide miss during probes',
    data: `${'a'.repeat(16_000)}${'\u20ac'.repeat(32_000)}`
  },
  { label: 'ascii 64KiB overflow proof', data: 'x'.repeat(64 * 1024) }
]

console.log('\nTerminal frame-fit gate only. Lower is better.')
console.log(
  `${pad('fixture', 34)} ${pad('result', 8)} ${pad('whole scan', 12)} ${pad('bounded', 11)} ${pad('speedup', 9)}`
)
for (const fixture of gateFixtures) {
  const previous = previousGate(fixture.data)
  const bounded = exceedsTerminalStreamChunkBytes(fixture.data)
  if (previous !== bounded) {
    throw new Error(`gate result differs for ${fixture.label}`)
  }
  const { previousMs, boundedMs } = measureGateInterleaved(fixture.data)
  console.log(
    `${pad(fixture.label, 34)} ${pad(bounded ? 'miss' : 'fit', 8)} ${pad(`${(previousMs * 1000).toFixed(2)} us`, 12)} ${pad(`${(boundedMs * 1000).toFixed(2)} us`, 11)} ${pad(boundedMs > 0 ? `${(previousMs / boundedMs).toFixed(2)}x` : 'n/a', 9)}`
  )
}
console.log(`gate fixtures=${gateFixtures.length}, checksum=${gateChecksum >>> 0}`)
console.log(
  'Every byte of remote terminal output crosses this function; the batcher flushes at\nTERMINAL_OUTPUT_BATCH_MAX_BYTES (64 KiB) or every 5 ms, so a busy remote agent pane\nruns it tens of times a second per subscribed stream.'
)
