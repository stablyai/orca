import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

const modulePath = 'src/main/daemon/terminal-history-legacy-scrollback-restore.ts'
const baselineSource = readFileSync(0, 'utf8')
assert.ok(
  baselineSource.includes('function truncateAltScreen'),
  'Pipe the baseline module on stdin'
)
const arms = {}
for (const [name, source] of [
  ['baseline', baselineSource],
  ['indexed', readFileSync(modulePath, 'utf8')]
]) {
  const result = await build({
    stdin: {
      contents: `export { truncateAltScreen } from './${modulePath}'`,
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    plugins: [
      {
        name: 'private-export',
        setup(api) {
          api.onLoad({ filter: /terminal-history-legacy-scrollback-restore\.ts$/ }, () => ({
            contents: `${source}\nexport { truncateAltScreen }`,
            loader: 'ts',
            resolveDir: dirname(resolve(modulePath))
          }))
        }
      }
    ]
  })
  arms[name] = (
    await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
    )
  ).truncateAltScreen
}

const on = '\x1b[?1049h'
const off = '\x1b[?1049l'
let differentialCases = 0
function verify(input) {
  assert.equal(arms.indexed(input), arms.baseline(input))
  differentialCases++
}
const tokens = [on, off, '\x1b[?1049', 'h', 'l', 'x']
function enumerate(prefix, depth) {
  verify(prefix)
  if (depth === 0) {
    return
  }
  for (const token of tokens) {
    enumerate(prefix + token, depth - 1)
  }
}
enumerate('', 6)

let seed = 90211
function random(max) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return Math.floor((seed / 0x100000000) * max)
}
const fragments = [...tokens, '\r\n', '\x1b[?1047h', '\x1b[0m', 'é中😀', '\ud800', '\x00']
for (let trial = 0; trial < 5000; trial++) {
  verify(Array.from({ length: random(300) }, () => fragments[random(fragments.length)]).join(''))
}
console.log(
  JSON.stringify({
    differentialCases,
    node: process.version,
    platform: process.platform,
    arch: process.arch
  })
)

const workloads = [
  ['empty', ''],
  ['plain 4KiB', 'x'.repeat(4096)],
  ['plain 16MiB', 'x'.repeat(16 * 1024 * 1024)],
  ['8 balanced', `${'x'.repeat(256)}${on}TUI${off}`.repeat(8)],
  ['1024 balanced', (on + 'x'.repeat(4096) + off + 'x'.repeat(4096)).repeat(1024)],
  ['1024 off', ('x'.repeat(8192) + off).repeat(1024)],
  ['1024 nested on', ('x'.repeat(8192) + on).repeat(1024)],
  [
    '1024 nested closed',
    ('x'.repeat(4096) + on).repeat(1024) + ('x'.repeat(4096) + off).repeat(1024)
  ],
  ['4096 off near 16MiB limit', ('x'.repeat(4088) + off).repeat(4096)]
]
function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return (sorted[3] + sorted[4]) / 2
}
for (const [name, input] of workloads) {
  const expected = arms.baseline(input)
  assert.equal(arms.indexed(input), expected)
  const samples = { baseline: [], indexed: [] }
  const repeats = input.length < 8192 ? 10000 : 1
  for (const arm of Object.values(arms)) {
    for (let warmup = 0; warmup < Math.min(100, repeats); warmup++) {
      assert.equal(arm(input), expected)
    }
  }
  for (const pair of buildCounterbalancedSchedule(8, 'baseline', 'indexed')) {
    for (const name of pair) {
      const start = performance.now()
      let result
      for (let repeat = 0; repeat < repeats; repeat++) {
        result = arms[name](input)
      }
      samples[name].push((performance.now() - start) / repeats)
      assert.equal(result, expected)
    }
  }
  console.log(
    JSON.stringify({
      name,
      bytes: Buffer.byteLength(input),
      medianMs: Object.fromEntries(
        Object.entries(samples).map(([name, values]) => [name, median(values)])
      )
    })
  )
}
