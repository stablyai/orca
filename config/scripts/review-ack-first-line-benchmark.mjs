import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

const baseline = process.argv[2] ?? '20ab9950654'
const file = 'src/renderer/src/components/right-sidebar/pr-comment-fixing-reply-body.ts'
async function load(contents) {
  const result = await build({
    stdin: { contents, loader: 'ts', resolveDir: dirname(resolve(file)) },
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
  execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' })
)
const after = await load(readFileSync(file, 'utf8'))
const results = []
for (const [name, body] of [
  ['short', 'Please rename this variable.'],
  [
    '100-lines',
    `<!-- metadata -->\n## Review findings\n${'Code sample with   details\n'.repeat(100)}`
  ],
  [
    '10000-lines',
    `<!-- metadata -->\n## Review findings\n${'Code sample with   details\n'.repeat(10000)}`
  ],
  ['blank-10000-lines', '# > * - _ `\n'.repeat(10000)]
]) {
  const comments = Array.from({ length: 10 }, (_, id) => ({
    id,
    author: 'reviewer',
    authorAvatarUrl: '',
    createdAt: '',
    url: '',
    body
  }))
  const arms = { before, after }
  assert.equal(
    after.buildPRCommentBatchConversationReplyBody(comments),
    before.buildPRCommentBatchConversationReplyBody(comments)
  )
  const run = (arm) => {
    global.gc?.()
    const start = performance.now()
    const cpuStart = process.cpuUsage()
    for (let i = 0; i < 10; i++) {
      arms[arm].buildPRCommentBatchConversationReplyBody(comments)
    }
    const cpu = process.cpuUsage(cpuStart)
    return { ms: (performance.now() - start) / 10, cpuMs: (cpu.user + cpu.system) / 10000 }
  }
  run('before')
  run('after')
  const samples = { before: [], after: [] }
  for (const pair of buildCounterbalancedSchedule(10, 'before', 'after')) {
    for (const arm of pair) {
      samples[arm].push(run(arm))
    }
  }
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    return (sorted[4] + sorted[5]) / 2
  }
  results.push({
    name,
    beforeCpuMs: median(samples.before.map((s) => s.cpuMs)),
    afterCpuMs: median(samples.after.map((s) => s.cpuMs)),
    beforeMs: median(samples.before.map((s) => s.ms)),
    afterMs: median(samples.after.map((s) => s.ms)),
    samples
  })
}
console.log(
  JSON.stringify({ baseline, node: process.version, platform: process.platform, results }, null, 2)
)
