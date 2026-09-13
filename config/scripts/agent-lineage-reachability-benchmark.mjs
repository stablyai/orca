import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { transform } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'

// git show <ref>:src/renderer/src/components/dashboard/agent-row-lineage-model.ts | node config/scripts/agent-lineage-reachability-benchmark.mjs
async function load(source) {
  const { code } = await transform(source, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`))
    .buildAgentRowLineageTree
}
const implementations = {
  before: await load(readFileSync(0, 'utf8')),
  after: await load(
    readFileSync('src/renderer/src/components/dashboard/agent-row-lineage-model.ts', 'utf8')
  )
}
function orderedTree(tree) {
  return {
    roots: tree.rootRows,
    children: [...tree.childrenByParentPaneKey],
    childKeys: [...tree.childPaneKeys]
  }
}

let seed = 42
const random = (max) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return Math.floor((seed / 2 ** 32) * max)
}
let differentialCases = 0
for (let trial = 0; trial < 5000; trial += 1) {
  const count = random(100)
  const rows = Object.freeze(
    Array.from({ length: count }, (_, index) =>
      Object.freeze({
        paneKey: `pane-${random(count + 4)}`,
        index,
        entry: Object.freeze({
          terminalHandle: random(2) ? `term-${random(count)}` : undefined,
          orchestration: Object.freeze({
            parentPaneKey: random(3) ? `pane-${random(count + 4)}` : undefined,
            parentTerminalHandle: random(2) ? `term-${random(count)}` : undefined,
            coordinatorHandle: random(2) ? `term-${random(count)}` : undefined
          })
        })
      })
    )
  )
  assert.deepEqual(
    orderedTree(implementations.after(rows)),
    orderedTree(implementations.before(rows))
  )
  differentialCases += 1
}

const results = []
for (const count of [8, 32, 128, 512, 1024]) {
  for (const shape of ['flat', 'fanout', 'balanced', 'chain']) {
    const rows = Array.from({ length: count }, (_, index) => {
      const parent =
        shape === 'fanout' ? 0 : shape === 'balanced' ? Math.floor((index - 1) / 4) : index - 1
      return {
        paneKey: `pane-${index}`,
        entry: {
          orchestration:
            index > 0 && shape !== 'flat' ? { parentPaneKey: `pane-${parent}` } : undefined
        }
      }
    })
    const expected = orderedTree(implementations.before(rows))
    assert.deepEqual(orderedTree(implementations.after(rows)), expected)
    const iterations = Math.max(5, Math.floor(10_000 / count))
    for (let warmup = 0; warmup < 20; warmup += 1) {
      implementations.before(rows)
      implementations.after(rows)
    }
    /** @type {{ before: number[], after: number[] }} */
    const samples = { before: [], after: [] }
    for (const pair of buildCounterbalancedSchedule(8, 'before', 'after')) {
      for (const arm of pair) {
        let result
        const started = performance.now()
        for (let repeat = 0; repeat < iterations; repeat += 1) {
          result = implementations[arm](rows)
        }
        samples[arm].push(performance.now() - started)
        assert.deepEqual(orderedTree(result), expected)
      }
    }
    results.push({
      count,
      shape,
      iterations,
      meanMicrosecondsPerTree: Object.fromEntries(
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
    { node: process.version, platform: process.platform, differentialCases, results },
    null,
    2
  )
)
