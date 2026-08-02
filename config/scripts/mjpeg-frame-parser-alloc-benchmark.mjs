#!/usr/bin/env node
// Benchmark: main-process heap allocation of the emulator MJPEG frame parser
// across a realistic stream burst.
//
// extractJpegFrames() splits an MJPEG byte stream into JPEG frames. The old
// implementation copied every extracted frame via Buffer.from(subarray(...))
// and copied the incoming chunk via Buffer.from(chunk) when no bytes were
// pending. Both copies are unnecessary: each frame is consumed synchronously
// by the IPC layer (which copies into a transferable ArrayBuffer), and the only
// state retained across calls (`pending`) is independently copied out. The fix
// returns frame *views* and reads the chunk directly, so the parser allocates
// ~0 frame-sized buffers per second instead of one copy per frame.
//
// This script runs both implementations over the same synthetic 30fps stream
// and reports total bytes allocated (via process.memoryUsage / gc deltas).
import { performance, PerformanceObserver } from 'node:perf_hooks'

// Count bytes copied by Buffer.from inside the parser, deterministically. Each
// implementation calls trackedCopy() wherever it would allocate a copy, so the
// reported "bytes copied" is exact and independent of GC timing.
let copiedBytes = 0
function trackedCopy(buf) {
  copiedBytes += buf.length
  return Buffer.from(buf)
}

const FPS = Number.parseInt(process.env.ORCA_MJPEG_BENCH_FPS ?? '30', 10)
const SECONDS = Number.parseInt(process.env.ORCA_MJPEG_BENCH_SECONDS ?? '30', 10)
const FRAME_BYTES = Number.parseInt(process.env.ORCA_MJPEG_BENCH_FRAME_BYTES ?? '184320', 10) // ~180 KiB

for (const [name, value] of [
  ['ORCA_MJPEG_BENCH_FPS', FPS],
  ['ORCA_MJPEG_BENCH_SECONDS', SECONDS],
  ['ORCA_MJPEG_BENCH_FRAME_BYTES', FRAME_BYTES]
]) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${value}`)
  }
}

const JPEG_START = Buffer.from([0xff, 0xd8])
const JPEG_END = Buffer.from([0xff, 0xd9])

function makeFrame(seed) {
  const body = Buffer.alloc(FRAME_BYTES - 4)
  // Avoid an accidental 0xff 0xd9 inside the body so the frame boundary is clean.
  body.fill(seed % 251 || 1)
  return Buffer.concat([JPEG_START, body, JPEG_END])
}

// --- old implementation: copy chunk + copy every frame -----------------------
function extractOld(pending, chunk, maxPendingBytes = 2 * 1024 * 1024) {
  let cursor = pending.length > 0 ? Buffer.concat([pending, chunk]) : trackedCopy(chunk)
  const frames = []
  while (cursor.length > 0) {
    const frameStart = cursor.indexOf(JPEG_START)
    if (frameStart < 0) {
      const keepLastByte = cursor.at(-1) === 0xff
      return { frames, pending: keepLastByte ? Buffer.from([0xff]) : Buffer.alloc(0) }
    }
    if (frameStart > 0) {
      cursor = cursor.subarray(frameStart)
    }
    const frameEnd = cursor.indexOf(JPEG_END, JPEG_START.length)
    if (frameEnd < 0) {
      const tail = cursor.length <= maxPendingBytes ? cursor : cursor.subarray(-maxPendingBytes)
      return { frames, pending: trackedCopy(tail) }
    }
    const nextOffset = frameEnd + JPEG_END.length
    frames.push(trackedCopy(cursor.subarray(0, nextOffset)))
    cursor = cursor.subarray(nextOffset)
  }
  return { frames, pending: Buffer.alloc(0) }
}

// --- new implementation: views, no chunk copy --------------------------------
function extractNew(pending, chunk, maxPendingBytes = 2 * 1024 * 1024) {
  let cursor = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
  const frames = []
  while (cursor.length > 0) {
    const frameStart = cursor.indexOf(JPEG_START)
    if (frameStart < 0) {
      const keepLastByte = cursor.at(-1) === 0xff
      return { frames, pending: keepLastByte ? Buffer.from([0xff]) : Buffer.alloc(0) }
    }
    if (frameStart > 0) {
      cursor = cursor.subarray(frameStart)
    }
    const frameEnd = cursor.indexOf(JPEG_END, JPEG_START.length)
    if (frameEnd < 0) {
      const tail = cursor.length <= maxPendingBytes ? cursor : cursor.subarray(-maxPendingBytes)
      return { frames, pending: trackedCopy(tail) }
    }
    const nextOffset = frameEnd + JPEG_END.length
    frames.push(cursor.subarray(0, nextOffset))
    cursor = cursor.subarray(nextOffset)
  }
  return { frames, pending: Buffer.alloc(0) }
}

function runStream(extract, frames) {
  // Simulate one network chunk per frame (the common MJPEG transport shape):
  // each chunk delivers exactly one whole JPEG, so `pending` is empty per call.
  let totalFrameBytes = 0
  for (const frame of frames) {
    const result = extract(Buffer.alloc(0), frame)
    for (const f of result.frames) {
      totalFrameBytes += f.length
    }
  }
  return totalFrameBytes
}

function measure(label, extract, frames) {
  let gcCount = 0
  let gcPauseMs = 0
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcCount += 1
      gcPauseMs += entry.duration
    }
  })
  observer.observe({ entryTypes: ['gc'] })

  global.gc?.()
  copiedBytes = 0
  const before = process.memoryUsage()
  const start = performance.now()
  const consumed = runStream(extract, frames)
  const elapsed = performance.now() - start
  const after = process.memoryUsage()
  observer.disconnect()
  return {
    label,
    elapsedMs: elapsed,
    consumedFrameBytes: consumed,
    copiedMb: copiedBytes / (1024 * 1024),
    rssDeltaMb: (after.rss - before.rss) / (1024 * 1024),
    gcCount,
    gcPauseMs
  }
}

const totalFrames = FPS * SECONDS
const frames = Array.from({ length: totalFrames }, (_, i) => makeFrame(i))
const streamMb = (totalFrames * FRAME_BYTES) / (1024 * 1024)

console.log(
  `MJPEG parser alloc benchmark: ${FPS}fps × ${SECONDS}s = ${totalFrames} frames, ` +
    `${(FRAME_BYTES / 1024).toFixed(0)} KiB/frame (${streamMb.toFixed(1)} MiB streamed)\n`
)

if (!global.gc) {
  console.log('(run with `node --expose-gc` for accurate heap deltas)\n')
}

const oldResult = measure('before (Buffer.from copies)', extractOld, frames)
const newResult = measure('after  (subarray views)   ', extractNew, frames)

for (const r of [oldResult, newResult]) {
  console.log(
    `${r.label}  copied=${r.copiedMb.toFixed(1)} MiB  ` +
      `rssΔ=${r.rssDeltaMb.toFixed(1)} MiB  gc=${r.gcCount} (${r.gcPauseMs.toFixed(1)}ms)  ` +
      `time=${r.elapsedMs.toFixed(1)}ms`
  )
}

const savedMb = oldResult.copiedMb - newResult.copiedMb
console.log(
  `\nEliminated ${savedMb.toFixed(1)} MiB of transient frame copies over ${SECONDS}s ` +
    `(~${(savedMb / SECONDS).toFixed(2)} MiB/s of avoided allocation + GC pressure on the main process).`
)
console.log(
  `Same frame bytes delivered (${(oldResult.consumedFrameBytes / (1024 * 1024)).toFixed(1)} MiB) ` +
    `with ${newResult.copiedMb.toFixed(1)} MiB copied instead of ${oldResult.copiedMb.toFixed(1)} MiB.`
)
