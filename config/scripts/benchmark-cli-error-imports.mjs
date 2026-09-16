import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

// Emit each revision with tsc -p config/tsconfig.cli.json --outDir <dir> --composite false --incremental false.
// Run: node config/scripts/benchmark-cli-error-imports.mjs <before-dir> <after-dir>
const [beforeDir, afterDir] = process.argv.slice(2)
assert.ok(beforeDir && afterDir, 'Pass distinct before and after TypeScript output directories.')
assert.notEqual(
  realpathSync(beforeDir),
  realpathSync(afterDir),
  'Do not compare a build to itself.'
)
const entries = {
  before: join(resolve(beforeDir), 'cli', 'index.js'),
  after: join(resolve(afterDir), 'cli', 'index.js')
}
for (const entry of Object.values(entries)) {
  assert.ok(existsSync(entry), `Missing emitted CLI: ${entry}`)
}

const { runProcessSync } = createRequire(import.meta.url)(
  join(resolve(afterDir), 'shared', 'child-process', 'run-process.js')
)

const child = String.raw`
  const { performance } = require('node:perf_hooks')
  const { writeSync } = require('node:fs')
  const { createHash } = require('node:crypto')
  const { basename } = require('node:path')
  let stdout = '', stderr = ''
  process.stdout.write = (text) => { stdout += text; return true }
  process.stderr.write = (text) => { stderr += text; return true }
  const started = performance.now()
  const cli = require(process.argv[1])
  const importMs = performance.now() - started
  cli.main(JSON.parse(process.argv[2])).then(() => {
    const totalMs = performance.now() - started
    const modules = Object.keys(require.cache)
    writeSync(1, JSON.stringify({
      importMs, totalMs, modules: modules.length,
      featureFormatters: modules.filter((file) => ['browser', 'terminal', 'project', 'automation', 'workspace', 'computer'].some((name) => basename(file) === name + '-format.js')),
      stdout: createHash('sha256').update(stdout).digest('hex'),
      stderr: createHash('sha256').update(stderr).digest('hex'),
      exitCode: process.exitCode || 0
    }))
    process.exitCode = 0
  }).catch((error) => { writeSync(2, String(error)); process.exitCode = 1 })
`
const cases = [
  ['--help'],
  ['help', 'terminal', 'read'],
  ['does-not-exist'],
  ['computer', 'click', '--does-not-exist'],
  ['does-not-exist', '--json']
]
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const summarize = (samples) => ({
  importMs: median(samples.map((sample) => sample.importMs)),
  totalMs: median(samples.map((sample) => sample.totalMs)),
  modules: samples[0].modules
})
const rows = []
for (const args of cases) {
  const samples = { before: [], after: [] }
  let expected
  for (let run = 0; run < 22; run++) {
    for (const variant of run % 2 ? ['after', 'before'] : ['before', 'after']) {
      const result = runProcessSync({
        program: process.execPath,
        args: ['-e', child, entries[variant], JSON.stringify(args)],
        timeoutMs: 30_000,
        env: {
          ...process.env,
          NODE_PATH: [resolve('node_modules'), process.env.NODE_PATH]
            .filter(Boolean)
            .join(delimiter)
        }
      })
      assert.equal(result.timedOut, false, 'CLI child timed out.')
      assert.equal(result.code, 0, result.stderr)
      const sample = JSON.parse(result.stdout)
      const output = { stdout: sample.stdout, stderr: sample.stderr, exitCode: sample.exitCode }
      expected ??= output
      assert.deepEqual(output, expected, `${variant} output changed for ${args.join(' ')}`)
      if (variant === 'after') {
        assert.deepEqual(
          sample.featureFormatters,
          [],
          'Help and syntax errors must skip feature formatters.'
        )
      }
      if (run >= 2) {
        samples[variant].push(sample)
      }
    }
  }
  assert.ok(samples.after[0].modules < samples.before[0].modules, 'Expected fewer loaded modules.')
  rows.push({
    args,
    before: summarize(samples.before),
    after: summarize(samples.after),
    output: expected,
    samples
  })
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      measurement:
        'Fresh-process import + main; excludes process creation; warmed filesystem; 2 warmups and 20 samples per variant, alternating order.',
      entries,
      rows
    },
    null,
    2
  )
)
