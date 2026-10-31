import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'

// git show <baseline-ref>:mobile/src/terminal/terminal-live-text-commit.ts | node config/scripts/mobile-backspace-benchmark.mjs
const target = resolve('mobile/src/terminal/terminal-live-text-commit.ts')
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
  ).getTerminalLiveAccessoryLocalEditText
}
const baseline = readFileSync(0, 'utf8')
assert.ok(
  baseline.includes('function getTerminalLiveAccessoryLocalEditText'),
  'Pipe baseline source into stdin'
)
const implementations = {
  before: await load(baseline),
  after: await load(readFileSync(target, 'utf8'))
}
const tokens = [
  '',
  'a',
  '\u0000',
  '\r',
  '\n',
  '한',
  '\u0301',
  '\u200d',
  '🙂',
  '\ud800',
  '\udbff',
  '\udc00',
  '\udfff'
]
let cases = 0
for (const first of tokens) {
  for (const second of tokens) {
    for (const third of tokens) {
      for (const localEdit of ['backspace', 'delete']) {
        const input = { fieldText: first + second + third, localEdit }
        assert.equal(
          implementations.after(input),
          implementations.before(input),
          JSON.stringify(input)
        )
        cases += 1
      }
    }
  }
}
const results = []
for (const inputBytes of [32, 4096, 65_536, 262_144]) {
  for (const glyph of ['a', '🙂']) {
    const fieldText = glyph.repeat(inputBytes / Buffer.byteLength(glyph))
    const input = { localEdit: 'backspace', fieldText }
    const expected = implementations.before(input)
    assert.equal(implementations.after(input), expected)
    const iterations = Math.max(10, Math.floor(1_000_000 / inputBytes))
    for (let warmup = 0; warmup < 100; warmup += 1) {
      implementations.before(input)
      implementations.after(input)
    }
    /** @type {{ before: number[], after: number[] }} */
    const samples = { before: [], after: [] }
    for (const pair of buildCounterbalancedSchedule(8, 'before', 'after')) {
      for (const arm of pair) {
        let actual
        const started = performance.now()
        for (let repeat = 0; repeat < iterations; repeat += 1) {
          actual = implementations[arm](input)
        }
        samples[arm].push(performance.now() - started)
        assert.equal(actual, expected)
      }
    }
    const means = Object.fromEntries(
      Object.entries(samples).map(([arm, values]) => [
        arm,
        (values.reduce((sum, ms) => sum + ms, 0) * 1000) / values.length / iterations
      ])
    )
    results.push({
      inputBytes,
      glyph,
      iterations,
      meanMicrosecondsPerCall: means,
      before: summarizeBenchmarkSamples(samples.before),
      after: summarizeBenchmarkSamples(samples.after)
    })
  }
}
console.log(
  JSON.stringify(
    { node: process.version, platform: process.platform, differentialCases: cases, results },
    null,
    2
  )
)
