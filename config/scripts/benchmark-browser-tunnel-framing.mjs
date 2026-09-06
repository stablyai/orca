import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { performance } from 'node:perf_hooks'

// Run from the worktree root: node config/scripts/benchmark-browser-tunnel-framing.mjs [base-ref]
const path = 'src/shared/browser-network-tunnel-stream-framing.ts'
const baselineRef = process.argv[2] ?? 'HEAD'
const beforeSource = execFileSync('git', ['show', `${baselineRef}:${path}`], {
  encoding: 'utf8'
})
const afterSource = readFileSync(path, 'utf8')
const load = (source) =>
  import(
    `data:text/javascript;base64,${Buffer.from(
      stripTypeScriptTypes(source, { mode: 'transform' })
    ).toString('base64')}`
  )
const before = await load(beforeSource)
const after = await load(afterSource)

function measure(module, chunks, payload, repetitions) {
  let frameCount = 0
  let lastFrame
  const onFrame = (frame) => {
    frameCount++
    lastFrame = frame
  }
  const onError = (error) => {
    throw error
  }
  const run = () => {
    const decoder = new module.BrowserNetworkTunnelStreamFrameDecoder(onFrame, onError)
    for (const chunk of chunks) {
      decoder.feed(chunk)
    }
  }
  run()
  assert.deepEqual(lastFrame, payload)
  const samples = []
  for (let sample = 0; sample < 5; sample++) {
    const start = performance.now()
    for (let iteration = 0; iteration < repetitions; iteration++) {
      run()
    }
    samples.push((performance.now() - start) / repetitions)
  }
  assert.equal(frameCount, 1 + 5 * repetitions)
  return samples.sort((a, b) => a - b)[2]
}

function countCopies(module, chunks) {
  const originalSet = Uint8Array.prototype.set
  const originalSlice = Uint8Array.prototype.slice
  let copied = 0
  Uint8Array.prototype.set = function (source, offset) {
    copied += source.length
    return originalSet.call(this, source, offset)
  }
  Uint8Array.prototype.slice = function (...args) {
    const result = originalSlice.apply(this, args)
    copied += result.length
    return result
  }
  try {
    const decoder = new module.BrowserNetworkTunnelStreamFrameDecoder(
      () => {},
      (error) => {
        throw error
      }
    )
    for (const chunk of chunks) {
      decoder.feed(chunk)
    }
  } finally {
    Uint8Array.prototype.set = originalSet
    Uint8Array.prototype.slice = originalSlice
  }
  return copied
}

const rows = []
for (const [payloadBytes, chunkBytes, repetitions] of [
  [1, 5, 10000],
  [64 * 1024, 65540, 1000],
  [64 * 1024, 4096, 100],
  [64 * 1024, 256, 25],
  [64 * 1024, 16, 5],
  [64 * 1024, 1, 1]
]) {
  const payload = Uint8Array.from({ length: payloadBytes }, (_, index) => index % 251)
  const encoded = before.encodeBrowserNetworkTunnelStreamFrame(payload)
  const chunks = []
  for (let offset = 0; offset < encoded.length; offset += chunkBytes) {
    chunks.push(encoded.subarray(offset, offset + chunkBytes))
  }
  const beforeMs = measure(before, chunks, payload, repetitions)
  const afterMs = measure(after, chunks, payload, repetitions)
  rows.push({
    payloadBytes,
    chunkBytes,
    beforeMs: +beforeMs.toFixed(6),
    afterMs: +afterMs.toFixed(6),
    speedup: +(beforeMs / afterMs).toFixed(2),
    beforeCopiedBytes: countCopies(before, chunks),
    afterCopiedBytes: countCopies(after, chunks)
  })
}
console.log(JSON.stringify({ node: process.version, baselineRef, rows }, null, 2))
