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
    'Usage: node config/scripts/mobile-linear-group-sorted-benchmark.mjs <baseline-ref>'
  )
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
const original = await load(
  file,
  execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8', windowsHide: true })
)
const current = await load(file, readFileSync(file, 'utf8'))
const sorterRef = process.argv[3]
const sorter = sorterRef
  ? await load(
      file,
      execFileSync('git', ['show', `${sorterRef}:${file}`], { encoding: 'utf8', windowsHide: true })
    )
  : original
const results = []
for (const count of [25, 200, 1000]) {
  const items = Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`,
    identifier: `ENG-${(i * 37) % count}`,
    updatedAt: new Date(1700000000000 - i * 100000).toISOString(),
    priority: i % 5,
    state: { name: `state-${i % 4}`, color: 'red' },
    team: { id: `team-${i % 3}`, name: 'Team' },
    assignee: null
  }))
  for (const order of ['identifier', 'updated', 'priority']) {
    const run = (arm) => {
      const sorted = sorter.sortLinearIssues
        ? sorter.sortLinearIssues(items, order)
        : [...items].sort((a, b) => sorter.compareLinearIssues(a, b, order))
      return arm === 'before'
        ? [
            sorter.groupLinearIssues(sorted, 'none', order),
            sorter.groupLinearIssues(sorted, 'status', order)
          ]
        : [
            current.groupSortedLinearIssues(sorted, 'none'),
            current.groupSortedLinearIssues(sorted, 'status')
          ]
    }
    assert.deepEqual(run('after'), run('before'))
    for (let i = 0; i < 10; i++) {
      run('before')
      run('after')
    }
    const samples = { before: [], after: [] }
    for (const pair of buildCounterbalancedSchedule(8, 'before', 'after')) {
      for (const arm of pair) {
        global.gc?.()
        const start = performance.now()
        for (let i = 0; i < 10; i++) {
          run(arm)
        }
        samples[arm].push((performance.now() - start) / 10)
      }
    }
    results.push({ count, order, samples })
  }
}
console.log(JSON.stringify({ baseline, sorterRef, node: process.version, results }, null, 2))
