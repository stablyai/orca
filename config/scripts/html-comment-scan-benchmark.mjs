import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

const baseline = process.argv[2] ?? '20ab9950654'
async function load(file, contents) {
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
const results = []
for (const [name, file, invoke] of [
  [
    'preview',
    'mobile/src/components/mobile-markdown-preview-html.ts',
    (module, text) => module.normalizeMobileMarkdownPreviewHtml(text)
  ],
  [
    'comment-blocks',
    'mobile/src/components/pr-sidebar/markdown-blocks.ts',
    (module, text) => module.parseMarkdownBlocks(text)
  ],
  [
    'ack-label',
    'src/renderer/src/components/right-sidebar/pr-comment-fixing-reply-body.ts',
    (module, text) => module.describePRCommentAckTarget({ body: text, url: '' })
  ]
]) {
  const arms = {
    before: await load(
      file,
      execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' })
    ),
    after: await load(file, readFileSync(file, 'utf8'))
  }
  for (const [shape, text] of [
    ['plain', '# Heading\nA normal document.'],
    ['complete', 'text<!--hidden-->more\n'.repeat(100)],
    ['unclosed-1000', '<!--x'.repeat(1000)],
    ['unclosed-4000', '<!--x'.repeat(4000)],
    ['unclosed-8000', '<!--x'.repeat(8000)],
    ['mixed-8000', `a<!--complete-->b${'<!--x'.repeat(8000)}`]
  ]) {
    assert.deepEqual(invoke(arms.after, text), invoke(arms.before, text))
    const iterations = shape.startsWith('unclosed') || shape.startsWith('mixed') ? 1 : 100
    const run = (arm) => {
      global.gc?.()
      const start = performance.now()
      const cpuStart = process.cpuUsage()
      for (let i = 0; i < iterations; i++) {
        invoke(arms[arm], text)
      }
      const cpu = process.cpuUsage(cpuStart)
      return {
        ms: (performance.now() - start) / iterations,
        cpuMs: (cpu.user + cpu.system) / 1000 / iterations
      }
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
      shape,
      beforeMs: median(samples.before.map((s) => s.ms)),
      afterMs: median(samples.after.map((s) => s.ms)),
      beforeCpuMs: median(samples.before.map((s) => s.cpuMs)),
      afterCpuMs: median(samples.after.map((s) => s.cpuMs)),
      samples
    })
  }
}
console.log(
  JSON.stringify({ baseline, node: process.version, platform: process.platform, results }, null, 2)
)
