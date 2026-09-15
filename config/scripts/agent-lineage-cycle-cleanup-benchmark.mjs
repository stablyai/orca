// Run: node --expose-gc config/scripts/agent-lineage-cycle-cleanup-benchmark.mjs [baseline-ref]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { transform } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

const sourcePath = 'src/renderer/src/components/dashboard/agent-row-lineage-model.ts'
const baseline = process.argv[2] ?? '20ab9950654'
const beforeSource = execFileSync('git', ['show', `${baseline}:${sourcePath}`], {
  encoding: 'utf8',
  windowsHide: true
})
async function load(source) {
  const { code } = await transform(source, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`))
    .buildAgentRowLineageTree
}
const before = await load(beforeSource)
const after = await load(await readFile(sourcePath, 'utf8'))

function row(index, parent) {
  return {
    paneKey: `pane-${index}`,
    entry: {
      terminalHandle: `term-${index}`,
      orchestration: parent === undefined ? undefined : { parentPaneKey: `pane-${parent}` }
    }
  }
}

// Exercise duplicate keys, disconnected cycles, missing parents, and handle fallback.
let seed = 7391
function random(max) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed % max
}
for (let sample = 0; sample < 500; sample++) {
  const rows = Array.from({ length: 40 }, () => {
    const value = row(random(30), random(40))
    value.entry.orchestration.parentTerminalHandle = `term-${random(40)}`
    value.entry.orchestration.coordinatorHandle = `term-${random(40)}`
    return value
  })
  if (sample % 2 === 0) {
    rows.unshift(row('root', undefined))
  }
  assert.deepEqual(after(rows), before(rows))
}

const results = []
for (const [shape, count] of [
  ['flat', 1000],
  ['all-cycles', 1000],
  ['mixed-cycles', 100],
  ['mixed-cycles', 500],
  ['mixed-cycles', 1000]
]) {
  const rows = Array.from({ length: count }, (_, index) =>
    row(index, shape === 'flat' ? undefined : index ^ 1)
  )
  if (shape === 'mixed-cycles') {
    rows.unshift(row('root', undefined))
  }
  assert.deepEqual(after(rows), before(rows))
  for (let warmup = 0; warmup < 30; warmup++) {
    before(rows)
    after(rows)
  }
  const samples = { before: [], after: [] }
  for (const pair of buildCounterbalancedSchedule(8, 'before', 'after')) {
    for (const arm of pair) {
      global.gc?.()
      const run = arm === 'before' ? before : after
      const cpu = process.cpuUsage()
      const start = performance.now()
      for (let iteration = 0; iteration < 30; iteration++) {
        run(rows)
      }
      const wallMs = (performance.now() - start) / 30
      const used = process.cpuUsage(cpu)
      samples[arm].push({ wallMs, cpuMs: (used.user + used.system) / 30_000 })
    }
  }
  results.push({ shape, count, samples })
}
console.log(
  JSON.stringify({ baseline, node: process.version, parityGraphs: 500, results }, null, 2)
)
