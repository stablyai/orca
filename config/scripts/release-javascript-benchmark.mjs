import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  javascriptInventory,
  releaseJavascriptConfiguration,
  restoreReleaseJavascript
} from './release-javascript-artifact.mjs'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'
import { runProcessSync } from '@orca/process-host'
import { describeProcessFailure } from './process-failure-message.mjs'
import {
  annotateJavascriptParityFiles,
  compareJavascriptParityFiles
} from './release-javascript-parity.mjs'

const root = resolve(import.meta.dirname, '../..')
const [mode, reportDir = '.build/release-javascript-measurements'] = process.argv.slice(2)

function runBuild(script) {
  const pnpm = resolvePnpmCliInvocation()
  const started = performance.now()
  const result = runProcessSync({
    program: pnpm.command,
    args: [...pnpm.prefixArgs, 'run', script],
    cwd: root,
    timeoutMs: 1_200_000,
    maxOutputBytes: 64 * 1024 * 1024,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  })
  const milliseconds = performance.now() - started
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  assert.equal(result.code, 0, describeProcessFailure(result))
  return milliseconds
}

function benchmark() {
  assert(['baseline', 'shared'].includes(mode), 'Expected baseline, shared, or summary')
  const configuration = releaseJavascriptConfiguration(root)
  let restoreMs = 0
  if (mode === 'shared') {
    const started = performance.now()
    restoreReleaseJavascript({
      root,
      artifactDir: join(root, '.build', 'release-javascript'),
      configuration
    })
    restoreMs = performance.now() - started
  }
  const buildMs = runBuild(mode === 'baseline' ? 'build:release' : 'build:release:host')
  const files = javascriptInventory(join(root, 'out'), '', { excludeHostOutput: true }).filter(
    (file) => !file.path.endsWith('.map')
  )
  const report = {
    mode,
    platform: process.platform,
    arch: process.arch,
    configuration,
    restoreMs,
    buildMs,
    files: annotateJavascriptParityFiles(join(root, 'out'), files)
  }
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(
    join(reportDir, `${mode}-${process.platform}-${process.arch}.json`),
    `${JSON.stringify(report)}\n`
  )
  console.log(
    `[release-javascript] ${mode}: build ${(buildMs / 1000).toFixed(2)}s, restore ${(restoreMs / 1000).toFixed(2)}s`
  )
}

function summarize() {
  const reports = readdirSync(reportDir, { recursive: true })
    .filter((file) => /(?:baseline|shared)-.*\.json$/.test(file))
    .map((file) => JSON.parse(readFileSync(join(reportDir, file), 'utf8')))
  const { jobs } = JSON.parse(readFileSync(join(reportDir, 'jobs.json'), 'utf8'))
  const seconds = (step) => (Date.parse(step.completed_at) - Date.parse(step.started_at)) / 1000
  const lines = [
    '| Host | Baseline build | Shared host build | Restore | Download | Saved per host | Runtime file differences |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'
  ]
  let savedMs = 0
  let differences = 0
  for (const baseline of reports.filter((report) => report.mode === 'baseline')) {
    const shared = reports.find(
      (report) =>
        report.mode === 'shared' &&
        report.platform === baseline.platform &&
        report.arch === baseline.arch
    )
    assert(shared, `Missing shared result for ${baseline.platform}/${baseline.arch}`)
    assert.deepEqual(shared.configuration, baseline.configuration)
    const job = jobs.find((job) => job.name === `shared ${baseline.platform} ${baseline.arch}`)
    assert(job, 'Missing shared job timing')
    const download = job.steps.find((step) => step.name === 'Download shared JavaScript')
    assert(download?.conclusion === 'success', 'Missing successful artifact download')
    const downloadMs = seconds(download) * 1000
    const changed = compareJavascriptParityFiles(baseline.files, shared.files)
    differences += changed.length
    const saved = baseline.buildMs - shared.buildMs - shared.restoreMs - downloadMs
    savedMs += saved
    const format = (ms) => `${(ms / 1000).toFixed(1)}s`
    lines.push(
      `| ${baseline.platform}/${baseline.arch} | ${format(baseline.buildMs)} | ${format(shared.buildMs)} | ${format(shared.restoreMs)} | ${format(downloadMs)} | ${format(saved)} | ${changed.length} |`
    )
    if (changed.length) {
      lines.push(
        `\nDifferences for ${baseline.platform}/${baseline.arch}: ${changed.slice(0, 20).join(', ')}\n`
      )
    }
  }
  assert.equal(reports.length, 8, 'Expected both measurements on all four packaging hosts')
  const producer = jobs.find((job) =>
    job.steps.some((step) => step.name === 'Build and archive release JavaScript')
  )
  assert(producer, 'Missing producer job timing')
  const producerSeconds = seconds(producer)
  lines.push(
    '',
    `Shared producer job: ${producerSeconds.toFixed(1)}s including setup, compilation, archiving and upload.`,
    `Net runner time saved across four hosts after charging the producer job: ${(savedMs / 1000 - producerSeconds).toFixed(1)}s.`,
    'Build measurements exclude consumer checkout/install and signing. Downloads and restoration are charged to shared builds. Runtime parity normalizes text line endings, asset references and manifest key order, excludes source maps, and permits native color rounding up to 0.00000101 in Display P3 or 0.00010001 in Lab. Other content must match. Artifact restoration always verifies exact producer hashes. The producer starts alongside release gates; any unfinished producer work still delays packaging.'
  )
  writeFileSync(join(reportDir, 'comparison.md'), `${lines.join('\n')}\n`)
  console.log(lines.join('\n'))
  assert.equal(differences, 0, 'Shared runtime output differs from per-host compilation')
}

if (mode === 'summary') {
  summarize()
} else {
  benchmark()
}
