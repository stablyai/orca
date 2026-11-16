// Run: node config/scripts/performance/mobile-projection/mobile-diff-benchmark.mjs --baseline-ref <commit>
// Compares committed and worktree preview preparation; no device or network I/O.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'
import { runProcessSync } from '@orca/process-host'
import { describeProcessFailure } from '../../tool-invocation/process-failure-message.mjs'
import { buildCounterbalancedSchedule } from '../measurement/counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from '../measurement/benchmark-sample-summary.mjs'

const root = resolve(import.meta.dirname, '../../../..')
const { values } = parseArgs({
  options: {
    'baseline-ref': { type: 'string', default: 'HEAD' },
    pairs: { type: 'string', default: '4' },
    output: {
      type: 'string',
      default: 'tests/tools/benchmarks/results/mobile-diff.json'
    }
  }
})
const schedule = buildCounterbalancedSchedule(Number(values.pairs), 'baseline', 'current')
const digest = (contents) => createHash('sha256').update(contents).digest('hex')
function execute(program, args) {
  const result = runProcessSync({
    program,
    args,
    cwd: root,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 60_000,
    maxOutputBytes: 4 * 1024 * 1024
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error(describeProcessFailure(result))
  }
  return result.stdout
}

const baselineCommit = execute('git', [
  'rev-parse',
  '--verify',
  `${values['baseline-ref']}^{commit}`
]).trim()
const temporary = mkdtempSync(join(tmpdir(), 'orca-mobile-diff-'))
try {
  const bundles = {}
  const sources = {}
  const entries = [
    'mobile/src/source-control/review/diff-state/mobile-diff-lines.ts',
    'mobile/src/source-control/review/diff-state/mobile-diff-review-rows.ts',
    'mobile/src/files/session-documents/mobile-file-syntax.ts'
  ]
  const legacyEntries = entries.map((entry) => entry.replace('/review/diff-state/', '/review/'))
  const baselineFiles = new Set(
    execute('git', ['ls-tree', '--name-only', baselineCommit, '--', ...entries, ...legacyEntries])
      .trim()
      .split('\n')
  )
  const baselineEntries = new Map(
    entries.map((entry, index) => {
      const historicalPath = baselineFiles.has(entry) ? entry : legacyEntries[index]
      if (!baselineFiles.has(historicalPath)) {
        throw new Error(`Missing baseline entry: ${entry}`)
      }
      return [entry, historicalPath]
    })
  )
  for (const arm of ['baseline', 'current']) {
    const hashes = {}
    const outfile = join(temporary, `${arm}.mjs`)
    await build({
      stdin: {
        contents: entries
          .map((entry) => `export * from ${JSON.stringify(join(root, entry))};`)
          .join('\n'),
        resolveDir: root,
        loader: 'ts'
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile,
      logLevel: 'silent',
      plugins: [
        {
          name: 'snapshot-diff-source-graph',
          setup(builder) {
            builder.onLoad({ filter: /\.ts$/ }, ({ path }) => {
              const sourcePath = relative(root, path).split(sep).join('/')
              if (!sourcePath.startsWith('mobile/src/') && !sourcePath.startsWith('src/')) {
                return undefined
              }
              const historicalPath = baselineEntries.get(sourcePath) ?? sourcePath
              const contents =
                arm === 'baseline'
                  ? execute('git', ['show', `${baselineCommit}:${historicalPath}`])
                  : readFileSync(path, 'utf8')
              hashes[arm === 'baseline' ? historicalPath : sourcePath] = digest(contents)
              return {
                contents,
                resolveDir:
                  arm === 'baseline' ? dirname(join(root, historicalPath)) : dirname(path),
                loader: 'ts'
              }
            })
          }
        }
      ]
    })
    bundles[arm] = outfile
    sources[arm] = { files: hashes, bundleSha256: digest(readFileSync(outfile)) }
  }

  const scenarios = [
    { name: 'small', lines: 200 },
    { name: 'sparse', lines: 10_000 },
    { name: 'sparse', lines: 100_000 },
    { name: 'scattered', lines: 10_000 },
    { name: 'rewrite', lines: 10_000 }
  ]
  const measurements = []
  const summary = []
  for (const scenario of scenarios) {
    const samples = { baseline: [], current: [] }
    for (let round = 0; round < schedule.length; round += 1) {
      for (const arm of schedule[round]) {
        const sample = JSON.parse(
          execute(process.execPath, [
            '--expose-gc',
            join(import.meta.dirname, 'mobile-diff-benchmark-worker.mjs'),
            bundles[arm],
            scenario.name,
            String(scenario.lines)
          ])
        )
        samples[arm].push(sample)
        measurements.push({ ...scenario, arm, round: round + 1, ...sample })
      }
    }
    for (const arm of ['baseline', 'current']) {
      const runs = samples[arm]
      summary.push({
        ...scenario,
        arm,
        buildMs: summarizeBenchmarkSamples(runs.map((run) => run.buildMs)),
        readyMs: summarizeBenchmarkSamples(runs.map((run) => run.readyMs)),
        meanRetainedHeapBytes:
          runs.reduce((sum, run) => sum + run.retainedHeapDeltaBytes, 0) / runs.length,
        maxProcessRssBytes: Math.max(...runs.map((run) => run.processPeakRssBytes)),
        outputLines: runs[0].outputLines,
        foldedRows: runs[0].foldedRows,
        truncated: runs[0].truncated,
        finalEditPresent: runs[0].finalEditPresent
      })
    }
    console.log(`Measured ${scenario.name}: ${scenario.lines.toLocaleString()} lines`)
  }

  const artifact = {
    recordedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model
    },
    baselineCommit,
    sources,
    schedule,
    instrumentation: {
      scope: 'CPU preparation only; excludes React rendering, layout, scrolling and network',
      baseline: 'committed diff builder, eager syntax highlighting, then context folding',
      current: 'worktree diff builder, bounded eager syntax highlighting, then context folding',
      isolation: 'fresh Node process per arm/scenario/round; two warmups; GC before measurement',
      timing: 'buildMs and readyMs exclude forced GC',
      heap: 'live output heap minus heap after releasing output, with two GCs at each point; input and imports remain live',
      endHeap: 'heap sampled immediately after preparation; not peak allocation',
      rss: 'absolute process high-water RSS including imports, inputs and warmups; not a diff-only peak',
      dependencies: 'both arms use currently installed npm dependencies',
      workerSha256: digest(
        readFileSync(join(import.meta.dirname, 'mobile-diff-benchmark-worker.mjs'))
      )
    },
    summary,
    measurements
  }
  const output = resolve(root, values.output)
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`)
  console.table(
    summary.map((row) => ({
      scenario: `${row.name}/${row.lines}`,
      arm: row.arm,
      'ready ms (median)': row.readyMs.medianMs,
      'retained heap MiB (mean)': (row.meanRetainedHeapBytes / 1024 ** 2).toFixed(2),
      'output lines': row.outputLines,
      'final edit': row.finalEditPresent
    }))
  )
  console.log(`Raw samples and source hashes: ${output}`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
