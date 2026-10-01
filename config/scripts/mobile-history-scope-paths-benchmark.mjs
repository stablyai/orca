import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

const baseline = process.argv[2]
if (!baseline) {
  throw new Error(
    'Usage: node config/scripts/mobile-history-scope-paths-benchmark.mjs <baseline-ref>'
  )
}
const file = 'mobile/src/agent-history/agent-history-scope-paths.ts'
async function load(contents) {
  const result = await build({
    stdin: { contents, loader: 'ts', resolveDir: dirname(resolve(file)) },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    tsconfigRaw: {}
  })
  return (
    await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
    )
  ).deriveMobileAiVaultScopePaths
}
const arms = {
  before: await load(execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' })),
  after: await load(readFileSync(file, 'utf8'))
}
const iterations = 200
const results = []
for (const [count, unique] of [
  [1, 1],
  [16, 16],
  [64, 64],
  [1000, 32]
]) {
  for (const root of ['/home/ada/café/project', 'C:\\Users\\ada\\café\\project']) {
    const rows = Array.from({ length: count }, (_, index) => ({
      worktreeId: `w-${index}`,
      repoId: 'repo',
      path: `${root}/workspace-${index % unique}`
    }))
    const expected = arms.before('project', rows[0], rows)
    assert.deepEqual(arms.after('project', rows[0], rows), expected)
    const samples = { before: [], after: [] }
    function run(arm) {
      let length = 0
      const start = performance.now()
      for (let i = 0; i < iterations; i++) {
        length += arms[arm]('project', rows[0], rows).length
      }
      const elapsed = performance.now() - start
      assert.equal(length, iterations * expected.length)
      return elapsed / iterations
    }
    for (const arm of ['before', 'after']) {
      run(arm)
    }
    for (const pair of buildCounterbalancedSchedule(10, 'before', 'after')) {
      for (const arm of pair) {
        samples[arm].push(run(arm))
      }
    }
    const median = (values) => {
      const sorted = [...values].sort((a, b) => a - b)
      return (sorted[4] + sorted[5]) / 2
    }
    results.push({
      count,
      unique,
      root,
      beforeMs: median(samples.before),
      afterMs: median(samples.after),
      samples
    })
  }
}
console.log(
  JSON.stringify(
    { baseline, node: process.version, platform: process.platform, iterations, results },
    null,
    2
  )
)
