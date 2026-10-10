import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'

// git show <baseline>:src/shared/native-chat-tool-fold.ts | node config/scripts/native-chat-tool-pairing-benchmark.mjs
const root = path.resolve(import.meta.dirname, '../..')
async function load(source) {
  const built = await build({
    stdin: {
      contents: source,
      sourcefile: 'native-chat-tool-fold.ts',
      resolveDir: path.join(root, 'src/shared'),
      loader: 'ts'
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm'
  })
  const code = built.outputFiles[0].text
  return {
    pair: (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`))
      .pairToolBlocks,
    bundleSha256: createHash('sha256').update(code).digest('hex')
  }
}

const loaded = {
  before: await load(readFileSync(0, 'utf8')),
  after: await load(readFileSync(path.join(root, 'src/shared/native-chat-tool-fold.ts'), 'utf8'))
}
const call = (callId) => ({ type: 'tool-call', name: 'Bash', input: {}, callId })
const result = (callId) => ({ type: 'tool-result', output: 'done', callId })
const results = []
for (const count of [1, 8, 32, 128, 512, 2048, 8192]) {
  const named = Array.from({ length: count }, (_, index) => call(`call-${index}`))
  const answers = named.map((block) => result(block.callId))
  const positional = Array.from({ length: count }, () => call(undefined))
  const repeated = Array.from({ length: count }, () => call('same'))
  const workloads = [
    { name: 'immediate-named', blocks: named.flatMap((block, index) => [block, answers[index]]) },
    { name: 'reverse-named', blocks: [...named, ...answers.toReversed()] },
    {
      name: 'fifo-positional',
      blocks: [...positional, ...positional.map(() => result(undefined))]
    },
    { name: 'duplicate-id', blocks: [...repeated, ...repeated.map(() => result('same'))] },
    {
      name: 'silent-call-backlog',
      blocks: [
        ...named,
        ...named.flatMap((_, index) => [call(`later-${index}`), result(`later-${index}`)])
      ]
    },
    { name: 'unmatched-named', blocks: [...named, ...named.map(() => result('missing'))] },
    { name: 'limited-reverse', blocks: [...named, ...answers.toReversed()], limit: 8 }
  ]
  for (const workload of workloads) {
    for (const block of workload.blocks) {
      Object.freeze(block)
    }
    Object.freeze(workload.blocks)
    const expected = loaded.before.pair(workload.blocks, workload.limit)
    assert.deepEqual(loaded.after.pair(workload.blocks, workload.limit), expected)
    const iterations = Math.max(4, Math.floor(16_384 / count))
    for (let warmup = 0; warmup < 16; warmup += 1) {
      loaded.before.pair(workload.blocks, workload.limit)
      loaded.after.pair(workload.blocks, workload.limit)
    }
    /** @type {{ before: number[], after: number[] }} */
    const samples = { before: [], after: [] }
    for (const pair of buildCounterbalancedSchedule(8, 'before', 'after')) {
      for (const arm of pair) {
        let actual
        const started = performance.now()
        for (let repeat = 0; repeat < iterations; repeat += 1) {
          actual = loaded[arm].pair(workload.blocks, workload.limit)
        }
        samples[arm].push(performance.now() - started)
        assert.deepEqual(actual, expected)
        actual.forEach((paired, index) => {
          assert.equal(paired.call, expected[index].call)
          assert.equal(paired.result, expected[index].result)
        })
      }
    }
    results.push({
      count,
      blocks: workload.blocks.length,
      workload: workload.name,
      limit: workload.limit ?? 'unlimited',
      iterations,
      meanMicrosecondsPerPairing: Object.fromEntries(
        Object.entries(samples).map(([arm, values]) => [
          arm,
          (values.reduce((sum, ms) => sum + ms, 0) * 1000) / values.length / iterations
        ])
      ),
      before: summarizeBenchmarkSamples(samples.before),
      after: summarizeBenchmarkSamples(samples.after),
      samplesMs: samples
    })
  }
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      bundleSha256: Object.fromEntries(
        Object.entries(loaded).map(([arm, value]) => [arm, value.bundleSha256])
      ),
      scope:
        'Production tool pairing only; excludes React, DOM, transcript projection and transport.',
      results
    },
    null,
    2
  )
)
