#!/usr/bin/env node
// Benchmark: the relay's per-PTY-chunk replay buffer append (src/relay/pty-handler.ts).
//
// appendReplayBuffer did `buffered += data` then, over the cap, `buffered.slice(-CAP)`.
// Once a PTY has produced CAP bytes -- which a long-lived shell does almost immediately
// -- every subsequent chunk flattened and copied the whole 100 KB window. The append is
// called per raw node-pty emission, before batching, so it is per chunk, not per flush.
//
// The fix reuses RecentPtyOutputBuffer: keep chunks, drop from the head, and defer the
// join to read(), which only attach/adopt/revive call.
//
// Both arms are compared for an identical retained tail before timing.
//
// Run with:  node config/scripts/relay-replay-buffer-benchmark.mjs
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

const ROUNDS = 6
const SECONDS = Number(process.env.ORCA_REPLAY_BENCH_SECONDS ?? '1')
if (!Number.isFinite(SECONDS) || SECONDS <= 0) {
  throw new Error(`ORCA_REPLAY_BENCH_SECONDS must be positive, received ${SECONDS}`)
}

// Why re-read the sources: the claim is that the relay now appends into a chunk deque
// with the relay's own cap. If either reverts, these numbers stop meaning what they say.
const HANDLER_SOURCE = readFileSync(
  new URL('../../src/relay/pty-handler.ts', import.meta.url),
  'utf8'
)
if (!/managed\.buffered\.append\(/.test(HANDLER_SOURCE)) {
  throw new Error('relay no longer appends into a chunk deque; this benchmark is stale')
}
const capMatch = HANDLER_SOURCE.match(/REPLAY_BUFFER_MAX = ([\d *]+)/)
if (!capMatch) {
  throw new Error('REPLAY_BUFFER_MAX not found; this benchmark is stale')
}
// The regex admits only digits, spaces, and `*`, so the literal is a plain product.
const REPLAY_BUFFER_MAX = capMatch[1]
  .split('*')
  .map((factor) => Number(factor.trim()))
  .reduce((product, factor) => product * factor, 1)
if (!Number.isSafeInteger(REPLAY_BUFFER_MAX) || REPLAY_BUFFER_MAX <= 0) {
  throw new Error(`could not read REPLAY_BUFFER_MAX from source, got ${capMatch[1]}`)
}

// Pre-fix: rolling string, re-sliced once over the cap.
function appendString(state, data) {
  if (data.length === 0) {
    return state
  }
  const next = state + data
  return next.length > REPLAY_BUFFER_MAX ? next.slice(-REPLAY_BUFFER_MAX) : next
}

// Post-fix: mirrors RecentPtyOutputBuffer's append/read for the relay's options.
class ChunkDeque {
  constructor(limit) {
    this.chunks = []
    this.headIndex = 0
    this.headOffset = 0
    this.totalLen = 0
    this.limit = limit
  }

  append(data) {
    if (data.length === 0) {
      return
    }
    if (data.length >= this.limit) {
      this.chunks = [data.slice(-this.limit)]
      this.headIndex = 0
      this.headOffset = 0
      this.totalLen = this.limit
      return
    }
    this.chunks.push(data)
    this.totalLen += data.length
    while (this.totalLen > this.limit) {
      const headRemaining = this.chunks[this.headIndex].length - this.headOffset
      const excess = this.totalLen - this.limit
      if (headRemaining <= excess) {
        this.chunks[this.headIndex] = ''
        this.headIndex += 1
        this.headOffset = 0
        this.totalLen -= headRemaining
      } else {
        this.headOffset += excess
        this.totalLen -= excess
      }
    }
    if (this.headIndex >= 1024) {
      this.chunks = this.chunks.slice(this.headIndex)
      this.headIndex = 0
    }
  }

  read() {
    if (this.chunks.length - this.headIndex > 1) {
      const retained = this.chunks.slice(this.headIndex)
      if (this.headOffset > 0) {
        retained[0] = retained[0].slice(this.headOffset)
        this.headOffset = 0
      }
      this.chunks = [retained.join('')]
      this.headIndex = 0
    } else if (this.headOffset > 0) {
      this.chunks[this.headIndex] = this.chunks[this.headIndex].slice(this.headOffset)
      this.headOffset = 0
    }
    return this.chunks[this.headIndex] ?? ''
  }
}

function makeChunks(chunkBytes, chunkCount) {
  // Vary content so V8 cannot dedupe or treat the appends as loop-invariant.
  return Array.from({ length: chunkCount }, (_value, index) =>
    `${index}:`.padEnd(chunkBytes, 'abcdefghijklmnopqrstuvwxyz')
  )
}

// Why pre-saturate: the interesting regime is a PTY that has already filled the window,
// which is where the old form copied 100 KB on literally every chunk. Timing from empty
// would average in a cheap warm-up the real process leaves behind in milliseconds.
function saturate(chunks) {
  let stringState = ''
  const deque = new ChunkDeque(REPLAY_BUFFER_MAX)
  const preload = 'p'.repeat(REPLAY_BUFFER_MAX)
  stringState = appendString(stringState, preload)
  deque.append(preload)
  return { stringState, deque, chunks }
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = sorted.length / 2
  return (sorted[mid - 1] + sorted[mid]) / 2
}

function timeString(chunks) {
  let state = 'p'.repeat(REPLAY_BUFFER_MAX)
  const start = performance.now()
  for (const chunk of chunks) {
    state = appendString(state, chunk)
  }
  const elapsed = performance.now() - start
  if (state.length !== REPLAY_BUFFER_MAX) {
    throw new Error('string arm lost its window')
  }
  return elapsed
}

function timeDeque(chunks) {
  const deque = new ChunkDeque(REPLAY_BUFFER_MAX)
  deque.append('p'.repeat(REPLAY_BUFFER_MAX))
  const start = performance.now()
  for (const chunk of chunks) {
    deque.append(chunk)
  }
  const elapsed = performance.now() - start
  return elapsed
}

// Arms alternate which one leads so within-round drift cannot favour either.
function measure(chunks) {
  timeString(chunks)
  timeDeque(chunks)
  const stringSamples = []
  const dequeSamples = []
  for (let round = 0; round < ROUNDS; round += 1) {
    if (round % 2 === 0) {
      stringSamples.push(timeString(chunks))
      dequeSamples.push(timeDeque(chunks))
    } else {
      dequeSamples.push(timeDeque(chunks))
      stringSamples.push(timeString(chunks))
    }
  }
  return { stringMs: median(stringSamples), dequeMs: median(dequeSamples) }
}

const pad = (value, width) => String(value).padStart(width)
console.log('Relay PTY replay-buffer append, per second of output. Lower is better.')
console.log(
  `cap=${(REPLAY_BUFFER_MAX / 1024).toFixed(0)} KiB rounds=${ROUNDS} (per-arm medians, pre-saturated)`
)
console.log(
  `${pad('workload', 30)} ${pad('rolling str', 12)} ${pad('chunk deque', 12)} ${pad('speedup', 9)}`
)

for (const [label, chunkBytes, chunksPerSecond] of [
  ['interactive shell 64B x200', 64, 200],
  ['agent TUI 512B x400', 512, 400],
  ['build log 4KiB x256 (1 MiB/s)', 4 * 1024, 256],
  ['dump 8KiB x512 (4 MiB/s)', 8 * 1024, 512],
  ['firehose 16KiB x1024 (16 MiB/s)', 16 * 1024, 1024]
]) {
  const chunks = makeChunks(chunkBytes, Math.round(chunksPerSecond * SECONDS))
  const { stringState, deque } = saturate(chunks)
  let stringTail = stringState
  for (const chunk of chunks) {
    stringTail = appendString(stringTail, chunk)
    deque.append(chunk)
  }
  if (deque.read() !== stringTail) {
    throw new Error(`retained tail differs for ${label}`)
  }
  if (stringTail.length !== REPLAY_BUFFER_MAX) {
    throw new Error(`fixture never saturated the window for ${label}`)
  }
  const { stringMs, dequeMs } = measure(chunks)
  console.log(
    `${pad(label, 30)} ${pad(`${stringMs.toFixed(3)} ms`, 12)} ${pad(`${dequeMs.toFixed(3)} ms`, 12)} ${pad(`${(stringMs / dequeMs).toFixed(0)}x`, 9)}`
  )
}

console.log(
  "\nThis is per PTY, and the relay runs on the user's SSH host. Reads (attach, adopt,\nrevive) now pay the join instead, but those are rare and were already O(window)."
)
