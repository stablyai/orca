import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { runProcessSync } from '@orca/process-host'
import { describeProcessFailure } from '../../tool-invocation/process-failure-message.mjs'
import { buildCounterbalancedSchedule } from '../measurement/counterbalanced-benchmark-schedule.mjs'

const baseline = process.argv[2]
if (!baseline) {
  throw new Error(
    'Usage: node config/scripts/performance/mobile-projection/mobile-source-control-collation-benchmark.mjs <baseline-ref>'
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
    plugins: [
      {
        name: 'historical-source-control-owners',
        setup(plugin) {
          plugin.onResolve(
            { filter: /^\.\.\/(?:mobile-git-status|git-status-reply-schema)$/ },
            (args) => {
              if (
                file !== 'mobile/src/source-control/review/mobile-diff-review-queue.ts' ||
                args.importer !== '<stdin>' ||
                args.resolveDir !== dirname(resolve(file))
              ) {
                return
              }
              const target =
                args.path === '../mobile-git-status'
                  ? 'mobile/src/source-control/changes/mobile-git-status.ts'
                  : 'mobile/src/source-control/git/git-status-reply-schema.ts'
              return { path: resolve(target) }
            }
          )
        }
      }
    ]
  })
  return (
    await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
    )
  )[name]
}
// Match git's path order, including its numeric-looking names, instead of inflating sort work with a shuffle.
const paths = execFileSync('git', ['ls-files', '-z'], { maxBuffer: 16 * 1024 * 1024 })
  .toString()
  .split('\0')
  .filter(Boolean)
const results = []
for (const { baselineLegacy, current, name } of [
  {
    baselineLegacy: 'mobile/src/source-control/mobile-git-status.ts',
    current: 'mobile/src/source-control/changes/mobile-git-status.ts',
    name: 'buildMobileSourceControlSections'
  },
  {
    baselineLegacy: 'mobile/src/source-control/mobile-branch-compare.ts',
    current: 'mobile/src/source-control/branches/mobile-branch-compare.ts',
    name: 'buildMobileBranchCompareSection'
  },
  {
    baselineLegacy: 'mobile/src/source-control/review/mobile-diff-review-queue.ts',
    current: 'mobile/src/source-control/review/diff-state/mobile-diff-review-queue.ts',
    name: 'buildMobileDiffReviewQueue'
  }
]) {
  const historicalFile = [...new Set([current, baselineLegacy])].find((file) => {
    const probe = runProcessSync({
      program: 'git',
      args: ['cat-file', '-t', `${baseline}:${file}`],
      cwd: process.cwd(),
      timeoutMs: 30_000,
      maxOutputBytes: 2 * 1024 * 1024
    })
    if (probe.timedOut || probe.outputTruncated || ![0, 128].includes(probe.code)) {
      throw new Error(describeProcessFailure(probe))
    }
    return probe.code === 0 && probe.stdout.trim() === 'blob'
  })
  assert(historicalFile, `Missing baseline entry: ${baselineLegacy}`)
  const arms = {
    before: await load(
      historicalFile,
      execFileSync('git', ['show', `${baseline}:${historicalFile}`], { encoding: 'utf8' }),
      name
    ),
    after: await load(current, readFileSync(current, 'utf8'), name)
  }
  for (const count of [0, 1, 17, 63, 1000]) {
    const step = Math.max(1, Math.floor(paths.length / Math.max(1, count)))
    const entries = Array.from({ length: count }, (_, index) => ({
      path: paths[index * step],
      area: 'unstaged',
      status: 'modified',
      ...(index % 37 === 0 ? { conflictStatus: 'unresolved' } : {})
    }))
    const input =
      name === 'buildMobileDiffReviewQueue'
        ? {
            worktreeId: 'workspace',
            statusEntries: entries,
            branchEntries: [],
            comments: [],
            reviewState: { version: 1, files: {} }
          }
        : entries
    assert.deepEqual(arms.after(input), arms.before(input))
    const iterations = count < 100 ? 100 : 10
    function run(arm) {
      const start = performance.now()
      for (let index = 0; index < iterations; index++) {
        arms[arm](input)
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
    results.push({
      name,
      count,
      beforeMs: median(samples.before),
      afterMs: median(samples.after),
      samples
    })
  }
}
console.log(
  JSON.stringify(
    {
      baseline,
      node: process.version,
      platform: process.platform,
      locale: new Intl.Collator().resolvedOptions().locale,
      results
    },
    null,
    2
  )
)
