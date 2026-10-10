import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

const baseline = process.argv[2]
if (!baseline) {
  throw new Error('Usage: node config/scripts/mobile-linear-sort-benchmark.mjs <baseline-ref>')
}
async function load(file, contents) {
  const result = await build({
    stdin: { contents, loader: 'ts', resolveDir: dirname(resolve(file)) },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    tsconfigRaw: {},
    plugins: [
      {
        name: 'theme-only',
        setup(bundler) {
          bundler.onResolve({ filter: /mobile-tasks-dependencies$/ }, () => ({
            path: resolve('mobile/src/theme/mobile-theme.ts')
          }))
        }
      }
    ]
  })
  return await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  )
}
const file = 'mobile/src/tasks/mobile-tasks-reviewer-linear.ts'
const before = await load(
  file,
  execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' })
)
const after = await load(file, readFileSync(file, 'utf8'))
const results = []
for (const count of [0, 1, 25, 200, 1000]) {
  const items = Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    identifier: `ENG-${(index * 37) % Math.max(1, count)}`,
    updatedAt: new Date(1700000000000 - index * 100000).toISOString(),
    priority: index % 5
  }))
  for (const sort of ['updated', 'identifier', 'priority']) {
    const arms = {
      before: () => [...items].sort((a, b) => before.compareLinearIssues(a, b, sort)),
      after: () => after.sortLinearIssues(items, sort)
    }
    assert.deepEqual(arms.after(), arms.before())
    const iterations = count < 100 ? 100 : 10
    function run(arm) {
      const start = performance.now()
      for (let i = 0; i < iterations; i++) {
        arms[arm]()
      }
      return (performance.now() - start) / iterations
    }
    const samples = { before: [], after: [] }
    run('before')
    run('after')
    for (const pair of buildCounterbalancedSchedule(10, 'before', 'after')) {
      for (const arm of pair) {
        samples[arm].push(run(arm))
      }
    }
    function median(values) {
      const sorted = [...values].sort((a, b) => a - b)
      return (sorted[4] + sorted[5]) / 2
    }
    const dateParses = {}
    const nativeParse = Date.parse
    for (const arm of ['before', 'after']) {
      let calls = 0
      Date.parse = (value) => {
        calls++
        return nativeParse(value)
      }
      try {
        arms[arm]()
      } finally {
        Date.parse = nativeParse
      }
      dateParses[arm] = calls
    }
    results.push({
      count,
      sort,
      dateParses,
      beforeMs: median(samples.before),
      afterMs: median(samples.after),
      samples
    })
  }
}
console.log(
  JSON.stringify({ baseline, node: process.version, platform: process.platform, results }, null, 2)
)
