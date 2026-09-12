import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'

// git show <baseline-ref>:src/main/browser/snapshot-engine.ts | node config/scripts/browser-snapshot-iframe-benchmark.mjs
const target = resolve('src/main/browser/snapshot-engine.ts')
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
  ).buildSnapshot
}
const baseline = readFileSync(0, 'utf8')
assert.ok(baseline.includes('function buildSnapshot'), 'Pipe baseline source into stdin')
const implementations = {
  before: await load(baseline),
  after: await load(readFileSync(target, 'utf8'))
}
function makeTree(count) {
  const children = Array.from({ length: count }, (_, index) => ({
    nodeId: String(index + 2),
    backendDOMNodeId: index + 2,
    role: { type: 'role', value: 'button' },
    name: { type: 'computedString', value: `Button ${index % 50}` }
  }))
  return [
    {
      nodeId: '1',
      role: { type: 'role', value: 'WebArea' },
      childIds: children.map((node) => node.nodeId)
    },
    ...children
  ]
}
function makeSender(nodes) {
  return async (method) => {
    if (method === 'Accessibility.enable') {
      return {}
    }
    if (method === 'Accessibility.getFullAXTree') {
      return { nodes }
    }
    if (method === 'Runtime.evaluate') {
      return { result: { value: '[]' } }
    }
    throw new Error(`Unexpected method: ${method}`)
  }
}
const results = []
for (const [mainRefs, frameCount, refsPerFrame] of [
  [100, 0, 0],
  [100, 1, 20],
  [500, 2, 250],
  [1000, 5, 1000],
  [2000, 10, 1000]
]) {
  const sender = makeSender(makeTree(mainRefs))
  const iframeSender = makeSender(makeTree(refsPerFrame))
  const sessions = new Map(
    Array.from({ length: frameCount }, (_, index) => [`frame-${index}`, `session-${index}`])
  )
  const run = (arm) => implementations[arm](sender, sessions, () => iframeSender)
  const expected = await run('before')
  assert.deepEqual(await run('after'), expected)
  for (let warmup = 0; warmup < 4; warmup += 1) {
    await run('before')
    await run('after')
  }
  const totalRefs = mainRefs + frameCount * refsPerFrame
  const iterations = Math.max(1, Math.floor(12_000 / totalRefs))
  const samples = { before: [], after: [] }
  for (const pair of buildCounterbalancedSchedule(8, 'before', 'after')) {
    for (const arm of pair) {
      const started = performance.now()
      let actual
      for (let repeat = 0; repeat < iterations; repeat += 1) {
        actual = await run(arm)
      }
      samples[arm].push(performance.now() - started)
      assert.deepEqual(actual, expected)
    }
  }
  results.push({
    mainRefs,
    frameCount,
    refsPerFrame,
    totalRefs,
    iterations,
    before: summarizeBenchmarkSamples(samples.before),
    after: summarizeBenchmarkSamples(samples.after)
  })
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2))
