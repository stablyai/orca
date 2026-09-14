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
              ? 'export const getRichMarkdownRoundTripOutput = () => { throw new Error("unexpected editor round trip") }'
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
  before: await load(
    execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8', windowsHide: true })
  ),
  after: await load(readFileSync(file, 'utf8'))
}
const results = []
for (const size of [20_000, 200_000, 600_000]) {
  for (const shape of ['lines', 'long-line']) {
    const phrase =
      shape === 'lines'
        ? 'Ordinary prose with a little `code`.\n'
        : 'Ordinary prose with a little `code`. '
    const content = phrase.repeat(Math.ceil(size / phrase.length)).slice(0, size)
    const invoke = (arm) =>
      arms[arm].getMarkdownRichModeEligibilityDecision({ content, sizeOverridden: false })
    assert.deepEqual(invoke('after'), invoke('before'))
    assert.equal(invoke('after').exceedsSizeLimit, false)
    for (let i = 0; i < 10; i++) {
      invoke('before')
      invoke('after')
    }
    const samples = { before: [], after: [] }
    for (const pair of buildCounterbalancedSchedule(8, 'before', 'after')) {
      for (const arm of pair) {
        global.gc?.()
        const cpuStart = process.cpuUsage()
        const start = performance.now()
        for (let i = 0; i < 20; i++) {
          invoke(arm)
        }
        const ms = (performance.now() - start) / 20
        const cpu = process.cpuUsage(cpuStart)
        samples[arm].push({ ms, cpuMs: (cpu.user + cpu.system) / 20_000 })
      }
    }
    results.push({ size, shape, samples })
  }
}
console.log(
  JSON.stringify(
    {
      baseline,
      node: process.version,
      roundTrip: 'throwing stub; these inputs must never invoke it',
      results
    },
    null,
    2
  )
)
