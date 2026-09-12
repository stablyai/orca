import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'

// git show <baseline-ref>:src/shared/check-job-log-tail-slice.ts | node config/scripts/check-job-log-tail-benchmark.mjs
const target = resolve('src/shared/check-job-log-tail-slice.ts')
async function load(source) {
  const result = await build({
    stdin: { contents: source, loader: 'ts', resolveDir: dirname(target) },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm'
  })
  return (
    await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
    )
  ).sliceCheckLogTail
}
const baseline = readFileSync(0, 'utf8')
assert.ok(baseline.includes('function sliceCheckLogTail'), 'Pipe the baseline source into stdin')
const implementations = {
  before: await load(baseline),
  after: await load(readFileSync(target, 'utf8'))
}
let seed = 20260911
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed
}
for (let sample = 0; sample < 2000; sample += 1) {
  const input = Array.from({ length: random() % 1000 }, (_, index) => {
    const token = ['ok', 'error:', 'FAILED', 'AssertionError', '', '🙂', '\r', '\ud800'][
      (random() >>> 16) % 8
    ]
    return `${index} ${token} ${'x'.repeat(random() % 250)}`
  }).join(sample % 2 === 0 ? '\n' : '\r\n')
  assert.equal(implementations.after(input), implementations.before(input), `sample ${sample}`)
}
const results = []
for (const lines of [200, 10_000, 100_000]) {
  for (const shape of ['no-errors', 'early-error', 'dense-errors', 'spaced-errors']) {
    const input = Array.from({ length: lines }, (_, index) => {
      const error =
        index < lines - 100 &&
        ((shape === 'early-error' && index === 2) ||
          shape === 'dense-errors' ||
          (shape === 'spaced-errors' && index % 100 === 0))
      return `${index} ${error ? 'error: failed assertion' : 'running installation'} ${'x'.repeat(64)}`
    }).join('\n')
    const expected = implementations.before(input)
    assert.equal(implementations.after(input), expected)
    const iterations = Math.max(1, Math.floor(100_000 / lines))
    for (let warmup = 0; warmup < 4; warmup += 1) {
      for (const run of Object.values(implementations)) {
        run(input)
      }
    }
    const samples = { before: [], after: [] }
    for (const pair of buildCounterbalancedSchedule(8, 'before', 'after')) {
      for (const arm of pair) {
        const started = performance.now()
        let actual
        for (let repeat = 0; repeat < iterations; repeat += 1) {
          actual = implementations[arm](input)
        }
        samples[arm].push(performance.now() - started)
        assert.equal(actual, expected)
      }
    }
    results.push({
      lines,
      shape,
      inputBytes: Buffer.byteLength(input),
      iterations,
      before: summarizeBenchmarkSamples(samples.before),
      after: summarizeBenchmarkSamples(samples.after)
    })
  }
}
console.log(
  JSON.stringify(
    { node: process.version, platform: process.platform, differentialCases: 2000, results },
    null,
    2
  )
)
