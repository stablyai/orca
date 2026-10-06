import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

const baseline = process.argv[2] ?? '20ab9950654'
const file = 'src/renderer/src/components/editor/markdown-rich-mode.ts'
async function load(contents) {
  const result = await build({
    stdin: { contents, loader: 'ts', resolveDir: dirname(resolve(file)) },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: [
      {
        name: 'cached-round-trip',
        setup(bundler) {
          bundler.onResolve({ filter: /markdown-round-trip$|^@\/i18n\/i18n$/ }, (args) => ({
            path: args.path,
            namespace: 'bench'
          }))
          bundler.onLoad({ filter: /.*/, namespace: 'bench' }, (args) => ({
            contents: args.path.endsWith('markdown-round-trip')
              ? 'export const getRichMarkdownRoundTripOutput = (content) => content'
              : 'export const translate = (_key, fallback) => fallback',
            loader: 'js'
          }))
        }
      }
    ]
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  )
}
const arms = {
  before: await load(execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' })),
  after: await load(readFileSync(file, 'utf8'))
}
const results = []
for (const [name, content] of [
  ['plain', '# Heading\nOrdinary prose with <placeholder>.'],
  ['complete', '<!-- metadata --><span>text</span>'],
  ['unclosed-1000', '<!--x'.repeat(1000)],
  ['unclosed-8000', '<!--x'.repeat(8000)],
  ['preserved-html-and-unclosed-8000', `<span>text</span>${'<!--x'.repeat(8000)}<b>tail</b>`]
]) {
  assert.equal(
    arms.after.getMarkdownRichModeUnsupportedReason(content),
    arms.before.getMarkdownRichModeUnsupportedReason(content)
  )
  const iterations = name.includes('unclosed') ? 2 : 100
  function run(arm) {
    global.gc?.()
    const start = performance.now()
    const cpuStart = process.cpuUsage()
    for (let i = 0; i < iterations; i++) {
      arms[arm].getMarkdownRichModeUnsupportedReason(content)
    }
    const cpu = process.cpuUsage(cpuStart)
    return {
      ms: (performance.now() - start) / iterations,
      cpuMs: (cpu.user + cpu.system) / 1000 / iterations
    }
  }
  run('before')
  run('after')
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
    name,
    beforeCpuMs: median(samples.before.map((s) => s.cpuMs)),
    afterCpuMs: median(samples.after.map((s) => s.cpuMs)),
    beforeMs: median(samples.before.map((s) => s.ms)),
    afterMs: median(samples.after.map((s) => s.ms)),
    samples
  })
}
console.log(
  JSON.stringify(
    {
      baseline,
      node: process.version,
      platform: process.platform,
      roundTrip:
        'identity stub, modeling an already-cached lossless round trip; editor parsing excluded',
      results
    },
    null,
    2
  )
)
