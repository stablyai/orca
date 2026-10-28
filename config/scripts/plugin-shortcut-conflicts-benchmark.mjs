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
    'Usage: node config/scripts/plugin-shortcut-conflicts-benchmark.mjs <baseline-ref>'
  )
}
async function load(file, contents, name) {
  const result = await build({
    stdin: { contents, loader: 'ts', resolveDir: dirname(resolve(file)) },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    tsconfigRaw: {},
    banner: {
      js: "import { createRequire as benchmarkRequire } from 'node:module'; import { resolve as benchmarkPath } from 'node:path'; const require = benchmarkRequire(benchmarkPath('package.json'));"
    }
  })
  return (
    await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
    )
  )[name]
}
const file = 'src/main/plugins/plugin-command-registry.ts'
const before = await load(
  file,
  execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' }),
  'PluginCommandRegistry'
)
const after = await load(file, readFileSync(file, 'utf8'), 'PluginCommandRegistry')
const results = []
for (const count of [1, 8, 32, 128]) {
  const plugins = Array.from({ length: count }, (_, index) => ({
    pluginKey: `sample.plugin-${index}`,
    manifest: {
      contributes: {
        commands: [
          {
            id: 'open',
            title: 'Open',
            action: 'view.tasks',
            context: index % 2 ? 'worktree' : 'global'
          }
        ],
        keybindings: [{ command: 'open', key: 'Mod+Alt+T' }]
      }
    }
  }))
  const arms = { before: new before(), after: new after() }
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const arm of Object.values(arms)) {
      arm.reconcile(plugins, () => true, {}, platform)
    }
    const snapshot = (registry) => ({
      active: registry.list(),
      previews: plugins.map((plugin) => registry.preview(plugin.pluginKey)),
      errors: plugins.map((plugin) => registry.error(plugin.pluginKey))
    })
    assert.deepEqual(snapshot(arms.after), snapshot(arms.before))
  }
  const iterations = 100
  function run(arm) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      arms[arm].reconcile(plugins, () => true, {}, 'linux')
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
  results.push({ count, beforeMs: median(samples.before), afterMs: median(samples.after), samples })
}
console.log(
  JSON.stringify({ baseline, node: process.version, platform: process.platform, results }, null, 2)
)
