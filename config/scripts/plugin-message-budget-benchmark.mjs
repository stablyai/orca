import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

const baseline = process.argv[2] ?? '20ab9950654'
const file = 'src/shared/plugins/plugin-panel-message-budget.ts'
async function load(contents) {
  const result = await build({
    stdin: { contents, loader: 'ts', resolveDir: dirname(resolve(file)) },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  )
}
const before = await load(
  execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' })
)
const after = await load(readFileSync(file, 'utf8'))
const results = []
for (const count of [5, 1000, 100000]) {
  const entries = Array.from({ length: count }, (_, i) => [`key-${i}`, `value-${i}`])
  for (const [kind, value] of [
    ['array', entries.map(([, value]) => value)],
    ['map', new Map(entries)],
    ['set', new Set(entries.map(([, value]) => value))],
    ['object', Object.fromEntries(entries)]
  ]) {
    const input = structuredClone(value)
    for (const cap of [0, 1, 64, 1024, 65536, Infinity]) {
      assert.equal(
        after.structuredCloneMessageBytes(input, cap),
        before.structuredCloneMessageBytes(input, cap)
      )
    }
    const arms = { before, after }
    const iterations = count < 100 ? 1000 : 10
    const run = (arm) => {
      global.gc?.()
      const start = performance.now()
      const cpuStart = process.cpuUsage()
      for (let i = 0; i < iterations; i++) {
        arms[arm].structuredCloneMessageBytes(input)
      }
      const cpu = process.cpuUsage(cpuStart)
      return {
        ms: (performance.now() - start) / iterations,
        cpuMs: (cpu.user + cpu.system) / 1000 / iterations
      }
    }
    for (let i = 0; i < 3; i++) {
      run('before')
      run('after')
    }
    const samples = { before: [], after: [] }
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
      kind,
      beforeMs: median(samples.before.map((sample) => sample.ms)),
      beforeCpuMs: median(samples.before.map((sample) => sample.cpuMs)),
      afterMs: median(samples.after.map((sample) => sample.ms)),
      afterCpuMs: median(samples.after.map((sample) => sample.cpuMs)),
      samples
    })
  }
}
console.log(
  JSON.stringify(
    {
      baseline,
      node: process.version,
      platform: process.platform,
      forcedGc: Boolean(global.gc),
      results
    },
    null,
    2
  )
)
