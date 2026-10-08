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
    'Usage: node config/scripts/mobile-source-control-collation-benchmark.mjs <baseline-ref>'
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
    tsconfigRaw: {}
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
for (const [file, name] of [
  ['mobile/src/source-control/mobile-git-status.ts', 'buildMobileSourceControlSections'],
  ['mobile/src/source-control/mobile-branch-compare.ts', 'buildMobileBranchCompareSection'],
  ['mobile/src/session/mobile-diff-review-queue.ts', 'buildMobileDiffReviewQueue']
]) {
  const arms = {
    before: await load(
      file,
      execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' }),
      name
    ),
    after: await load(file, readFileSync(file, 'utf8'), name)
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
