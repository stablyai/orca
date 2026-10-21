import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'

// Pipe baseline report then submission modules on stdin, in that order. No device/network I/O.
const baseline = readFileSync(0, 'utf8')
const divider = '\nconst CONNECTION_DIAGNOSTICS_ENDPOINT = '
assert.equal(baseline.split(divider).length, 2)
const split = baseline.indexOf(divider) + 1
const files = ['report', 'submission'].map((name) =>
  path.resolve(`mobile/src/diagnostics/connection-diagnostics-${name}.ts`)
)
const sources = [
  [baseline.slice(0, split), baseline.slice(split)],
  files.map((file) => readFileSync(file, 'utf8'))
]
const modules = await Promise.all(
  sources.map(async (contents) => {
    const result = await build({
      stdin: {
        contents: files.map((file) => `export * from ${JSON.stringify(file)};`).join('\n'),
        resolveDir: process.cwd()
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      plugins: [
        {
          name: 'actual-mobile-diagnostics',
          setup(builder) {
            builder.onLoad(
              { filter: /connection-diagnostics-(report|submission)\.ts$/ },
              (args) => ({
                contents: contents[files.indexOf(args.path)],
                loader: 'ts',
                resolveDir: path.dirname(args.path)
              })
            )
            builder.onResolve({ filter: /^@react-native-async-storage\/async-storage$/ }, () => ({
              path: 'forbidden-device-storage',
              namespace: 'fixture'
            }))
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
              contents: `function forbidden() { throw new Error('Device storage is forbidden'); }
                export default { getItem: forbidden, setItem: forbidden };`
            }))
          }
        }
      ]
    })
    const code = `${result.outputFiles[0].text}\n//# sourceURL=mobile-diagnostics-prefix-bundle.js`
    return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  })
)

const base = {
  hostName: 'fixture',
  endpoint: 'ws://192.168.1.2:6768',
  state: 'reconnecting',
  reconnectAttempts: 2,
  lastConnectedAt: null,
  platform: 'android',
  appVersion: 'fixture',
  nowMs: 1700000000000
}
let seed = 0x20d1a6
function random(max) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return (seed >>> 8) % max
}
const tokens = ['a', 'é', '界', '😀', '\ud800', '\udc00', '\n', '\r\n', '\0', 'e\u0301']
const limits = [
  Number.NEGATIVE_INFINITY,
  -1,
  0,
  1,
  2,
  3,
  4,
  15,
  16,
  17,
  100,
  511,
  2048,
  65536,
  Number.POSITIVE_INFINITY,
  Number.NaN,
  2.5
]
for (let trace = 0; trace < 3000; trace++) {
  const lines = Array.from({ length: 1 + random(12) }, () =>
    Array.from({ length: 1 + random(5) }, () =>
      tokens[random(tokens.length)].repeat(random(100))
    ).join('')
  )
  if (trace % 2) {
    lines.splice(random(lines.length), 0, 'Recent connection history (fixture):')
  }
  const report = lines.join('\n')
  const limit = limits[random(limits.length)]
  assert.equal(
    modules[1].boundConnectionDiagnosticsReport(report, limit),
    modules[0].boundConnectionDiagnosticsReport(report, limit)
  )
}
console.log('3,000 report-bound differentials match, including nonfinite/fractional limits')

for (let trace = 0; trace < 600; trace++) {
  const entries = Object.freeze(
    Array.from({ length: random(12) }, (_, index) =>
      Object.freeze({
        id: String(index),
        ts: base.nowMs + index,
        level: ['info', 'error', 'warn'][random(3)],
        message: ['Authenticated', 'relay director resolve failed (503)', 'fixture'][random(3)],
        detail: `${tokens[random(tokens.length)].repeat(random(4000))} token=fixture-secret`,
        code: ['client-session-started', 'liveness-timeout', undefined][random(3)],
        path: ['relay', 'lan', 'tailscale'][random(3)]
      })
    )
  )
  const args = Object.freeze({
    ...base,
    hostName: 'fixture token=host-fixture-secret',
    endpoint: trace % 2 ? base.endpoint : 'invalid?token=endpoint-fixture-secret',
    desktopAppVersion: trace % 2 ? '1.2.3' : '\ninvalid',
    state: ['connected', 'reconnecting', 'connecting'][random(3)],
    activePath: ['relay', 'lan', 'tailscale'][random(3)],
    pendingPath: trace % 3 ? null : 'relay',
    entries
  })
  const reports = modules.map((module) => module.buildConnectionDiagnosticsReport(args))
  assert.equal(reports[1], reports[0])
  assert(!reports[1].includes('fixture-secret'))
  const limit = limits[random(limits.length)]
  assert.equal(
    modules[1].boundConnectionDiagnosticsReport(reports[1], limit),
    modules[0].boundConnectionDiagnosticsReport(reports[0], limit)
  )
}
console.log('600 frozen report-build + bound journeys preserve redaction, diagnosis and exact text')

function runSample(run, repeats) {
  let value
  const start = performance.now()
  for (let index = 0; index < repeats; index++) {
    value = run()
  }
  return { value, elapsed: (performance.now() - start) / repeats }
}
function benchmark(name, arms) {
  const expected = arms[0]()
  assert.equal(arms[1](), expected)
  for (const arm of arms) {
    const until = performance.now() + 200
    do {
      assert.equal(arm(), expected)
    } while (performance.now() < until)
  }
  const repeats = Math.max(3, Math.min(10000, Math.ceil(40 / runSample(arms[0], 1).elapsed)))
  /** @type {number[][]} */
  const times = [[], []]
  for (let pair = 0; pair < 8; pair++) {
    for (const index of pair % 2 ? [1, 0] : [0, 1]) {
      const result = runSample(arms[index], repeats)
      assert.equal(result.value, expected)
      times[index].push(result.elapsed)
    }
  }
  const median = times.map((values) => {
    const sorted = values.toSorted((a, b) => a - b)
    return (sorted[3] + sorted[4]) / 2
  })
  console.log(JSON.stringify({ name, repeats, median, times }))
}
console.log(
  JSON.stringify({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    unit: 'ms'
  })
)
for (const [events, length, token] of [
  [0, 0, 'a'],
  [20, 80, 'a'],
  [200, 80, 'a'],
  [200, 1000, 'a'],
  [200, 4000, 'a'],
  [200, 2000, '😀']
]) {
  const args = {
    ...base,
    entries: Array.from({ length: events }, (_, i) => ({
      id: String(i),
      ts: base.nowMs + i,
      level: 'error',
      message: `fixture-${i} ${token.repeat(length)}`
    }))
  }
  const reports = modules.map((module) => module.buildConnectionDiagnosticsReport(args))
  assert.equal(reports[1], reports[0])
  const label = `${events} events / ${length} ${token}`
  benchmark(
    `${label}: build`,
    modules.map((module) => () => module.buildConnectionDiagnosticsReport(args))
  )
  benchmark(
    `${label}: bound`,
    modules.map((module) => () => module.boundConnectionDiagnosticsReport(reports[0]))
  )
}

for (const token of ['a', '😀', '\ud800']) {
  const report = token.repeat(100000)
  const results = await Promise.all(
    modules.map(async (module) => {
      let request
      const result = await module.submitConnectionDiagnostics(
        { report, platform: 'android', appVersion: 'fixture' },
        async (url, options) => {
          assert.equal(options.signal.aborted, false)
          request = { url, method: options.method, headers: options.headers, body: options.body }
          return { ok: true }
        }
      )
      return { result, request }
    })
  )
  assert.deepEqual(results[1], results[0])
}
console.log('Three fake-fetch submission journeys preserve complete request bytes and results')
