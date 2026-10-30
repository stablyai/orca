import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'

// git show <ref>:src/main/ai-vault/session-scanner-accumulator.ts | node config/scripts/session-timeline-benchmark.mjs
const target = resolve('src/main/ai-vault/session-scanner-accumulator.ts')
async function load(source) {
  const result = await build({
    stdin: {
      contents: `
        export {createAccumulator, cloneSessionAccumulator, updateTimeline, finalizeSession}
          from './session-scanner-accumulator';
        export {createClaudeSessionParseState, consumeClaudeSessionLine}
          from './session-scanner-primary-parsers';`,
      loader: 'ts',
      resolveDir: dirname(target)
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'timeline-baseline',
        setup(plugin) {
          plugin.onLoad({ filter: /session-scanner-accumulator\.ts$/ }, () => ({
            contents: source,
            loader: 'ts',
            resolveDir: dirname(target)
          }))
        }
      }
    ]
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  )
}
const implementations = {
  before: await load(readFileSync(0, 'utf8')),
  after: await load(readFileSync(target, 'utf8'))
}
const file = { path: 'timeline.jsonl', mtimeMs: 0, modifiedAt: '2026-01-01T00:00:00.000Z' }
const create = (implementation) =>
  implementation.createAccumulator({ agent: 'claude', sessionId: 'timeline', file })
const observable = ({ createdAt, updatedAt, latestTimestampMs }) => ({
  createdAt,
  updatedAt,
  latestTimestampMs
})

let seed = 42
const random = (max) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return Math.floor((seed / 2 ** 32) * max)
}
const tokens = [
  null,
  undefined,
  '',
  'bad',
  0,
  -1,
  Infinity,
  Number.NaN,
  8_640_000_000_000_001,
  '1969-12-31T23:59:59.999Z',
  '-000001-01-01T00:00:00.000Z',
  '+010000-01-01T00:00:00.000Z',
  '2026-01-01T01:00:00+01:00',
  1_700_000_000.0009,
  1_700_000_000_000.9,
  1_700_000_000_000.1,
  1_700_000_000_000 - 0.1
]
let differentialUpdates = 0
for (let trial = 0; trial < 3000; trial += 1) {
  let before = create(implementations.before)
  let after = create(implementations.after)
  for (let index = 0; index < 32; index += 1) {
    const input = random(2) ? tokens[random(tokens.length)] : 1_700_000_000_000 + random(1000) / 10
    const update = (implementation, state) => {
      try {
        implementation.updateTimeline(state, input)
      } catch (error) {
        return String(error)
      }
      return null
    }
    assert.equal(update(implementations.after, after), update(implementations.before, before))
    assert.deepEqual(observable(after), observable(before))
    if (index === 15) {
      before = implementations.before.cloneSessionAccumulator(before)
      after = implementations.after.cloneSessionAccumulator(after)
    }
    differentialUpdates += 1
  }
  assert.deepEqual(
    implementations.after.finalizeSession(after, 'linux'),
    implementations.before.finalizeSession(before, 'linux')
  )
}

const results = []
for (const records of [100, 10_000, 100_000]) {
  for (const workload of [
    'numeric-timeline',
    'iso-timeline',
    'out-of-order-timeline',
    'claude-record-fold'
  ]) {
    const timestamps = Array.from({ length: records }, (_, index) => {
      const ms =
        1_700_000_000_000 + (workload === 'out-of-order-timeline' ? random(records) : index)
      return workload === 'numeric-timeline' ? ms : new Date(ms).toISOString()
    })
    const lines =
      workload === 'claude-record-fold'
        ? timestamps.map((timestamp, index) =>
            JSON.stringify({
              type: index % 2 ? 'assistant' : 'user',
              sessionId: 'timeline',
              timestamp,
              message: {
                role: index % 2 ? 'assistant' : 'user',
                content: 'Example transcript message'
              }
            })
          )
        : []
    function run(arm) {
      const implementation = implementations[arm]
      const parser = implementation.createClaudeSessionParseState(file)
      const state = workload === 'claude-record-fold' ? parser.accumulator : create(implementation)
      const started = performance.now()
      if (workload === 'claude-record-fold') {
        for (const line of lines) {
          implementation.consumeClaudeSessionLine(parser, line)
        }
      } else {
        for (const timestamp of timestamps) {
          implementation.updateTimeline(state, timestamp)
        }
      }
      const ms = performance.now() - started
      return {
        ms,
        result: implementation.finalizeSession(state, 'linux'),
        timeline: observable(state)
      }
    }
    const expected = run('before')
    assert.deepEqual(run('after').result, expected.result)
    /** @type {{ before: number[], after: number[] }} */
    const samples = { before: [], after: [] }
    for (const pair of buildCounterbalancedSchedule(8, 'before', 'after')) {
      for (const arm of pair) {
        const actual = run(arm)
        samples[arm].push(actual.ms)
        assert.deepEqual(actual.result, expected.result)
        assert.deepEqual(actual.timeline, expected.timeline)
      }
    }
    results.push({
      records,
      workload,
      before: summarizeBenchmarkSamples(samples.before),
      after: summarizeBenchmarkSamples(samples.after)
    })
  }
}
console.log(
  JSON.stringify(
    { node: process.version, platform: process.platform, differentialUpdates, results },
    null,
    2
  )
)
