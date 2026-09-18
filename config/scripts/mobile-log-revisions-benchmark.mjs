import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

const baseline = process.argv[2] ?? '20ab9950654'
const file = 'mobile/src/transport/connection-log-buffer.ts'
async function load(contents) {
  const result = await build({
    stdin: { contents, loader: 'ts', resolveDir: dirname(resolve(file)) },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    tsconfigRaw: {}
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  )
}
const before = await load(
  execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' })
)
const after = await load(readFileSync(file, 'utf8'))
const drain = () => new Promise((resolve) => setImmediate(resolve))
async function run(module, count, startup) {
  let calls = 0
  let bytes = 0
  let stored = ''
  const store = module.createConnectionLogStore(200, {
    load: async () => [],
    save: async (_host, snapshot) => {
      stored = JSON.stringify(snapshot)
      calls++
      bytes += Buffer.byteLength(stored)
    }
  })
  if (!startup) {
    await store.hydrate('a')
    await drain()
    calls = 0
    bytes = 0
  }
  const start = performance.now()
  for (let i = 0; i < count; i++) {
    store.append('a', { id: `${i}`, ts: i, level: 'info', message: `connection event ${i}` })
  }
  await drain()
  return { ms: performance.now() - start, calls, bytes, stored }
}
const results = []
for (const count of [1, 25, 200, 1000]) {
  for (const startup of [false, true]) {
    const arms = { before, after }
    const initialBefore = await run(before, count, startup)
    const initialAfter = await run(after, count, startup)
    assert.equal(initialAfter.stored, initialBefore.stored)
    const samples = { before: [], after: [] }
    for (const pair of buildCounterbalancedSchedule(10, 'before', 'after')) {
      for (const arm of pair) {
        samples[arm].push((await run(arms[arm], count, startup)).ms)
      }
    }
    const median = (values) => {
      const sorted = [...values].sort((a, b) => a - b)
      return (sorted[4] + sorted[5]) / 2
    }
    results.push({
      count,
      startup,
      before: {
        calls: initialBefore.calls,
        bytes: initialBefore.bytes,
        ms: median(samples.before)
      },
      after: { calls: initialAfter.calls, bytes: initialAfter.bytes, ms: median(samples.after) }
    })
  }
}
console.log(
  JSON.stringify({ baseline, node: process.version, platform: process.platform, results }, null, 2)
)
