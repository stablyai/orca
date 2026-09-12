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
    'Usage: node config/scripts/mobile-review-note-index-benchmark.mjs <baseline-ref>'
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
const file = 'mobile/src/session/mobile-diff-review-queue.ts'
const name = 'buildMobileDiffReviewQueue'
const arms = {
  before: await load(
    file,
    execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' }),
    name
  ),
  after: await load(file, readFileSync(file, 'utf8'), name)
}
const results = []
for (const [files, notes] of [
  [0, 1000],
  [1, 1000],
  [50, 0],
  [50, 50],
  [1000, 1000],
  [1000, 5000]
]) {
  const input = {
    worktreeId: 'workspace',
    statusEntries: Array.from({ length: files }, (_, index) => ({
      path: `file-${index}.ts`,
      area: 'unstaged',
      status: 'modified'
    })),
    branchEntries: [],
    reviewState: { version: 1, files: {} },
    comments: Array.from({ length: notes }, (_, index) => ({
      id: `note-${index}`,
      worktreeId: 'workspace',
      filePath: `file-${index % Math.max(1, files)}.ts`,
      body: 'note',
      createdAt: 1,
      lineNumber: 1,
      side: 'modified',
      ...(index % 5 === 0 ? { scope: 'staged' } : {}),
      ...(index % 7 === 0 ? { sentAt: 1 } : {})
    }))
  }
  assert.deepEqual(arms.after(input), arms.before(input))
  const iterations = files < 100 ? 100 : 10
  function run(arm) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
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
    files,
    notes,
    beforeMs: median(samples.before),
    afterMs: median(samples.after),
    samples
  })
}
console.log(
  JSON.stringify({ baseline, node: process.version, platform: process.platform, results }, null, 2)
)
