import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'

// Pipe the baseline check-job-log-tail-slice.ts on stdin; both arms use the actual UTF-8 implementation.
const entry = path.resolve('src/shared/check-job-log-tail-slice.ts')
const sources = [readFileSync(0, 'utf8'), readFileSync(entry, 'utf8')]
assert(sources.every((source) => source.includes('export function sliceCheckLogTail')))

async function load(source) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: [
      {
        name: 'log-excerpt-source',
        setup(builder) {
          builder.onLoad({ filter: /check-job-log-tail-slice\.ts$/ }, () => ({
            contents: source,
            loader: 'ts',
            resolveDir: path.dirname(entry)
          }))
        }
      }
    ]
  })
  const bundled = `${result.outputFiles[0].text}\n//# sourceURL=check-log-byte-cap-benchmark-bundle.js`
  return import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`)
}

const modules = await Promise.all(sources.map(load))
const arms = modules.map((module) => module.sliceCheckLogTail)
const limit = modules[0].PR_CHECK_LOG_TAIL_BYTES
assert.equal(modules[1].PR_CHECK_LOG_TAIL_BYTES, limit)
let seed = 0xc0ffee16
function random(max) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return (seed >>> 8) % max
}

let comparisons = 0
function compare(text) {
  const expected = arms[0](text)
  assert.equal(arms[1](text), expected)
  assert(Buffer.byteLength(expected, 'utf8') <= limit)
  comparisons++
  return expected
}

const units = ['x', 'é', '界', '😀', '\ud83d', '\udc00', 'x\ud83d界\udc00']
for (const unit of units) {
  for (let delta = -4; delta <= 4; delta++) {
    const text = unit.repeat(Math.floor(limit / Buffer.byteLength(unit)) + delta)
    compare(text)
    compare(`error: ${text}\n${'recent\n'.repeat(103)}`)
  }
}
const endings = ['\n', '\r\n', '\r', '']
const tokens = [
  'plain text',
  '##[error]',
  '::error::',
  'error:',
  'FAILED',
  'exit code',
  'ENOENT',
  'EACCES',
  'panic:',
  'AssertionError',
  'emoji 😀',
  '\ud83d',
  '\udc00',
  '\0',
  '界',
  'é',
  '\r'
]
for (let iteration = 0; iteration < 5000; iteration++) {
  const rows = Array.from({ length: random(250) }, (_, index) => {
    const token = tokens[random(tokens.length)]
    if (index === 0 && iteration % 20 === 0) {
      return `${token}${units[random(units.length)].repeat(limit + random(4))}`
    }
    return `${token} ${index} ${units[random(units.length)].repeat(random(30))}`
  })
  compare(rows.join(endings[random(endings.length)]) + endings[random(endings.length)])
}
console.log(`${comparisons} full-output differential cases passed`)

const workloads = [
  ['short ASCII', 'log '.repeat(16)],
  ['short Unicode', '🦀界'.repeat(20)],
  ['8KiB ASCII', 'x'.repeat(8192)],
  ['16KiB ASCII exact cap', 'x'.repeat(limit)],
  ['8Ki code units / 24KiB Unicode', '界'.repeat(8192)],
  ['2MiB ASCII line', 'x'.repeat(2 * 1024 * 1024)],
  ['8MiB ASCII line', 'x'.repeat(8 * 1024 * 1024)],
  ['2MiB Unicode line', '界'.repeat(Math.floor((2 * 1024 * 1024) / 3))],
  [
    '2MiB earlier error context',
    `error: ${'x'.repeat(2 * 1024 * 1024)}\n${'recent\n'.repeat(103)}`
  ],
  [
    '220 ordinary lines',
    Array.from({ length: 220 }, (_, i) => `line ${i} ${'text'.repeat(8)}`).join('\n')
  ],
  [
    '220 lines / small earlier error',
    Array.from(
      { length: 220 },
      (_, i) => `${i === 30 ? 'error:' : 'line'} ${i} ${'text'.repeat(8)}`
    ).join('\n')
  ]
]

function sample(arm, input, expected, repeats) {
  const started = performance.now()
  let output
  for (let i = 0; i < repeats; i++) {
    output = arm(input)
  }
  const elapsed = (performance.now() - started) / repeats
  assert.equal(output, expected)
  return elapsed
}

console.log(
  JSON.stringify({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pairs: 8,
    unit: 'ms'
  })
)
for (const [name, input] of workloads) {
  const expected = compare(input)
  for (const arm of arms) {
    const until = performance.now() + 80
    while (performance.now() < until) {
      sample(arm, input, expected, 1)
    }
  }
  const repeats = Math.max(1, Math.min(100000, Math.ceil(40 / sample(arms[0], input, expected, 1))))
  /** @type {number[][]} */
  const samples = [[], []]
  for (let pair = 0; pair < 8; pair++) {
    for (const index of pair % 2 ? [1, 0] : [0, 1]) {
      samples[index].push(sample(arms[index], input, expected, repeats))
    }
  }
  const median = samples.map((values) => {
    values.sort((a, b) => a - b)
    return (values[3] + values[4]) / 2
  })
  console.log(JSON.stringify({ name, repeats, median, samples }))
}
