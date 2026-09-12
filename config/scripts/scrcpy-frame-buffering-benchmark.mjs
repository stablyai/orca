import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { transform } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'

// git show <ref>:src/main/emulator/android/scrcpy-video-frame-parser.ts | node config/scripts/scrcpy-frame-buffering-benchmark.mjs
async function load(source) {
  const { code } = await transform(source, { loader: 'ts', format: 'esm' })
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}
const before = (await load(readFileSync(0, 'utf8'))).parseScrcpyVideoFrames
const after = (
  await load(readFileSync('src/main/emulator/android/scrcpy-video-frame-parser.ts', 'utf8'))
).parseScrcpyVideoFrames
const { RelayFrameBuffer } = await load(readFileSync('src/shared/relay-frame-buffer.ts', 'utf8'))

function reader(arm) {
  if (arm === 'before') {
    let pending = Buffer.alloc(0)
    return {
      read(chunk) {
        // Match the baseline session's copy before invoking its production parser.
        const result = before(Buffer.alloc(0), Buffer.concat([pending, chunk]))
        pending = result.pending
        return result.frames
      },
      pending: () => pending
    }
  }
  const pending = new RelayFrameBuffer()
  return {
    read(chunk) {
      // Include the session's mandatory ownership copy in the queued parser arm.
      if (chunk.length > 0) {
        pending.append(Buffer.from(chunk))
      }
      return after(pending)
    },
    pending: () => (pending.length > 0 ? pending.peek(pending.length) : Buffer.alloc(0))
  }
}

function packet(size, meta = 123n) {
  const frame = Buffer.alloc(size + 12, 7)
  frame.writeBigUInt64BE(meta, 0)
  frame.writeUInt32BE(size, 8)
  return frame
}

let seed = 42
const random = (max) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed % max
}
let differentialChunks = 0
for (let trial = 0; trial < 1000; trial += 1) {
  const stream = Buffer.concat(
    Array.from({ length: 1 + random(8) }, (_, index) =>
      packet(random(256), (BigInt(random(4)) << 62n) | BigInt(index))
    )
  )
  const oldReader = reader('before')
  const newReader = reader('after')
  for (let offset = 0; offset < stream.length;) {
    const size = 1 + random(128)
    const chunk = stream.subarray(offset, offset + size)
    assert.deepEqual(newReader.read(chunk), oldReader.read(chunk))
    assert.deepEqual(newReader.pending(), oldReader.pending())
    assert.deepEqual(newReader.read(Buffer.alloc(0)), oldReader.read(Buffer.alloc(0)))
    differentialChunks += 1
    offset += size
  }
}

const results = []
for (const frameBytes of [32, 4096, 65_536, 1_048_576]) {
  const frame = packet(frameBytes)
  const expected = reader('before').read(frame)
  for (const chunkBytes of new Set([frame.length, 65_536, 4096, 1024])) {
    if (chunkBytes > frame.length) {
      continue
    }
    const chunks = []
    for (let offset = 0; offset < frame.length; offset += chunkBytes) {
      chunks.push(frame.subarray(offset, offset + chunkBytes))
    }
    const iterations = Math.max(10, Math.floor(4_194_304 / frameBytes))
    function run(arm, repeats) {
      const parser = reader(arm)
      let frames
      const started = performance.now()
      for (let iteration = 0; iteration < repeats; iteration += 1) {
        for (const chunk of chunks) {
          frames = parser.read(chunk)
        }
      }
      const ms = performance.now() - started
      assert.deepEqual(frames, expected)
      assert.equal(parser.pending().length, 0)
      return ms
    }
    run('before', iterations)
    run('after', iterations)
    /** @type {{ before: number[], after: number[] }} */
    const samples = { before: [], after: [] }
    for (const pair of buildCounterbalancedSchedule(8, 'before', 'after')) {
      for (const arm of pair) {
        samples[arm].push(run(arm, iterations))
      }
    }
    results.push({
      frameBytes,
      chunkBytes,
      iterations,
      meanMicrosecondsPerFrame: Object.fromEntries(
        Object.entries(samples).map(([arm, values]) => [
          arm,
          (values.reduce((sum, ms) => sum + ms, 0) * 1000) / values.length / iterations
        ])
      ),
      before: summarizeBenchmarkSamples(samples.before),
      after: summarizeBenchmarkSamples(samples.after)
    })
  }
}
console.log(
  JSON.stringify(
    { node: process.version, platform: process.platform, differentialChunks, results },
    null,
    2
  )
)
