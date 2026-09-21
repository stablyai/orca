import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

const modulePath = 'src/main/native-chat/transcript-stream-lines.ts'
const baselineSource = readFileSync(0, 'utf8')
assert.ok(baselineSource.includes('decodeTranscriptStream'), 'Pipe the baseline module on stdin')
const arms = {}
for (const [name, source] of [
  ['baseline', baselineSource],
  ['fragmented', readFileSync(modulePath, 'utf8')]
]) {
  const output = await build({
    stdin: {
      contents: `${source}\nexport { decodeClaudeTranscriptLine } from './transcript-line-decoders'`,
      loader: 'ts',
      resolveDir: dirname(resolve(modulePath))
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false
  })
  arms[name] = await import(
    `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`
  )
}

const path = '/fixture/transcript.jsonl'
const decode = (line, id) => ({ id, line })
let seed = 90211
function random(max) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return Math.floor((seed / 0x100000000) * max)
}

async function observe(arm, chunks, start, includeTrailing, throwAt) {
  const calls = []
  const stream = Readable.from(chunks)
  try {
    const result = await arm.decodeTranscriptStream(
      stream,
      path,
      start,
      (line, id) => {
        calls.push({ line, id })
        if (calls.length === throwAt) {
          throw new Error('fixture decode error')
        }
        return line.startsWith('skip') ? null : decode(line, id)
      },
      includeTrailing
    )
    return { calls, result, destroyed: stream.destroyed }
  } catch (error) {
    return { calls, error: error.message, destroyed: stream.destroyed }
  }
}

const tokens = ['a', '\r', '\n', '😀', 'é中', '\ud83d', '\ude00', 'skip', '\x00', '\u2028']
for (let trial = 0; trial < 5000; trial++) {
  let chunks
  if (trial % 2) {
    const raw = Buffer.from(Array.from({ length: random(100) }, () => random(256)))
    chunks = []
    for (let offset = 0; offset < raw.length;) {
      const end = Math.min(raw.length, offset + 1 + random(8))
      chunks.push(raw.subarray(offset, end))
      offset = end
    }
  } else {
    chunks = Array.from({ length: random(30) }, () => {
      const text = Array.from({ length: random(15) }, () => tokens[random(tokens.length)]).join('')
      return random(3) ? text : Buffer.from(text)
    })
  }
  const start = [0, 123, -1, 0.5, Number.MAX_SAFE_INTEGER - 3, Infinity, Number.NaN][random(7)]
  const includeTrailing = Boolean(random(2))
  const throwAt = random(7) === 0 ? 1 + random(4) : Infinity
  const expected = await observe(arms.baseline, chunks, start, includeTrailing, throwAt)
  const actual = await observe(arms.fragmented, chunks, start, includeTrailing, throwAt)
  assert.deepEqual(actual, expected)
}
console.log(
  JSON.stringify({
    differentialCases: 5000,
    node: process.version,
    platform: process.platform,
    arch: process.arch
  })
)

function splitInput(input, chunkSize, kind) {
  const raw = kind === 'buffer' ? Buffer.from(input) : input
  const chunks = []
  for (let offset = 0; offset < raw.length; offset += chunkSize) {
    chunks.push(raw.slice(offset, offset + chunkSize))
  }
  return chunks
}
const workloads = []
for (const [size, chunkSize, kind] of [
  [4096, 65536, 'string'],
  [2 * 1024 * 1024, 65536, 'string'],
  [8 * 1024 * 1024, 65536, 'string'],
  [2 * 1024 * 1024, 4096, 'buffer'],
  [8 * 1024 * 1024, 1024 * 1024, 'buffer']
]) {
  const input = `${'x'.repeat(size)}\n`
  workloads.push({
    name: `${size}B record/${chunkSize}B ${kind}`,
    chunks: splitInput(input, chunkSize, kind),
    includeTrailing: true
  })
}
workloads.push({
  name: '10000 short records/64KiB strings',
  chunks: splitInput('ordinary record\r\n'.repeat(10000), 65536, 'string'),
  includeTrailing: true
})
for (const includeTrailing of [false, true]) {
  workloads.push({
    name: `2MiB partial trailing/include=${includeTrailing}`,
    chunks: splitInput(`complete\n${'x'.repeat(2 * 1024 * 1024)}`, 65536, 'string'),
    includeTrailing
  })
}
for (const size of [4096, 2 * 1024 * 1024, 8 * 1024 * 1024]) {
  const input = `${JSON.stringify({
    type: 'user',
    uuid: 'message-1',
    timestamp: '2026-09-11T10:00:00Z',
    message: { role: 'user', content: 'x'.repeat(size) }
  })}\n`
  workloads.push({
    name: `${size}B Claude record with real decoder`,
    chunks: splitInput(input, 65536, 'string'),
    includeTrailing: true,
    claude: true
  })
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return (sorted[3] + sorted[4]) / 2
}
for (const workload of workloads) {
  const run = (arm) =>
    arms[arm].decodeTranscriptStream(
      Readable.from(workload.chunks),
      path,
      0,
      workload.claude ? arms[arm].decodeClaudeTranscriptLine : decode,
      workload.includeTrailing
    )
  const expected = await run('baseline')
  assert.deepEqual(await run('fragmented'), expected)
  if (workload.claude) {
    assert.equal(expected.messages.length, 1)
  }
  const samples = { baseline: [], fragmented: [] }
  const repeats = workload.chunks.length === 1 ? 100 : 5
  for (const arm of Object.keys(arms)) {
    for (let warmup = 0; warmup < 5; warmup++) {
      await run(arm)
    }
  }
  for (const pair of buildCounterbalancedSchedule(8, 'baseline', 'fragmented')) {
    for (const arm of pair) {
      const start = performance.now()
      let actual
      for (let repeat = 0; repeat < repeats; repeat++) {
        actual = await run(arm)
      }
      samples[arm].push((performance.now() - start) / repeats)
      assert.deepEqual(actual, expected)
    }
  }
  console.log(
    JSON.stringify({
      name: workload.name,
      medianMs: Object.fromEntries(
        Object.entries(samples).map(([arm, values]) => [arm, median(values)])
      )
    })
  )
}
