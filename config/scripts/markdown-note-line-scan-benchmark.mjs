import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

const sourcePath = 'src/renderer/src/lib/markdown-review-notes.ts'
const baseline = process.argv[2] ?? '20ab9950654'
async function load(contents) {
  const result = await build({
    stdin: { contents, loader: 'ts', resolveDir: dirname(resolve(sourcePath)) },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  )
}
const before = await load(
  execFileSync('git', ['show', `${baseline}:${sourcePath}`], { encoding: 'utf8' })
)
const after = await load(readFileSync(sourcePath, 'utf8'))
const results = []
for (const [name, lineCount, width, count, iterations] of [
  ['small', 20, 40, 1, 1000],
  ['long-lines', 1000, 1000, 20, 3],
  ['many-lines', 20000, 80, 20, 3],
  ['early-note', 20000, 80, 1, 1000]
]) {
  const content = Array.from({ length: lineCount }, (_, i) => `${i}: ${'x'.repeat(width)}`).join(
    '\r\n'
  )
  const notes = Array.from({ length: count }, (_, i) => ({
    id: `${i}`,
    worktreeId: 'bench',
    filePath: 'README.md',
    source: 'markdown',
    lineNumber: name === 'early-note' ? 2 : lineCount - i,
    body: 'Clarify this line',
    createdAt: i,
    side: 'modified'
  }))
  assert.equal(
    after.formatMarkdownReviewNotes(notes, content),
    before.formatMarkdownReviewNotes(notes, content)
  )
  const arms = { before, after }
  const samples = { before: [], after: [] }
  function run(arm) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      arms[arm].formatMarkdownReviewNotes(notes, content)
    }
    return (performance.now() - start) / iterations
  }
  for (let i = 0; i < 6; i++) {
    run('before')
    run('after')
  }
  for (const pair of buildCounterbalancedSchedule(12, 'before', 'after')) {
    for (const arm of pair) {
      samples[arm].push(run(arm))
    }
  }
  const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  results.push({
    name,
    lineCount,
    width,
    count,
    beforeMs: median(samples.before),
    afterMs: median(samples.after)
  })
}
console.log(
  JSON.stringify({ node: process.version, platform: process.platform, baseline, results }, null, 2)
)
