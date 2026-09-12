import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'

// git show <baseline-ref>:src/shared/source-scan/source-tree-scan.ts | node config/scripts/source-tree-walk-benchmark.mjs
async function load(source) {
  const code = stripTypeScriptTypes(source)
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`))
    .scanSourceTree
}
const baseline = readFileSync(0, 'utf8')
assert.ok(baseline.includes('function scanSourceTree'), 'Pipe the baseline source into stdin')
const implementations = {
  before: await load(baseline),
  after: await load(readFileSync('src/shared/source-scan/source-tree-scan.ts', 'utf8'))
}
function fingerprint(files) {
  const hash = createHash('sha256')
  for (const file of files) {
    for (const value of [file.path, file.relativePath, file.source]) {
      hash
        .update(String(Buffer.byteLength(value)))
        .update(':')
        .update(value)
    }
  }
  return hash.digest('hex')
}
const results = []
for (const directory of ['src', 'mobile/src', 'cloud/apps']) {
  const root = resolve(directory)
  const original = implementations.before(root)
  const expected = fingerprint(original)
  assert.deepEqual(implementations.after(root), original)
  const samples = { before: [], after: [] }
  for (let warmup = 0; warmup < 2; warmup += 1) {
    for (const run of Object.values(implementations)) {
      run(root)
    }
  }
  for (const pair of buildCounterbalancedSchedule(8, 'before', 'after')) {
    for (const arm of pair) {
      const started = performance.now()
      const files = implementations[arm](root)
      samples[arm].push(performance.now() - started)
      assert.equal(fingerprint(files), expected, `${directory} ${arm} inventory changed`)
    }
  }
  results.push({
    directory,
    files: original.length,
    sourceBytes: original.reduce((bytes, file) => bytes + Buffer.byteLength(file.source), 0),
    fingerprint: expected,
    before: summarizeBenchmarkSamples(samples.before),
    after: summarizeBenchmarkSamples(samples.after)
  })
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2))
