#!/usr/bin/env node
// Adverse-input audit: compares the previous scanner with the production line-bounded implementation.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'

const entry = fileURLToPath(
  new URL(
    '../../src/renderer/src/components/editor/monaco-markdown-doc-link-decorations.ts',
    import.meta.url
  )
)
const source = await readFile(entry, 'utf8')
const current = `${String.raw`/\s*(?:`}\`\`\`|~~~)/y`
const replacement = `${String.raw`/[^\S\n]*(?:`}\`\`\`|~~~)/y`
assert.ok(
  source.includes(replacement),
  'Production fence regex changed; re-review benchmark candidate'
)
async function load(candidate) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: candidate
      ? [
          {
            name: 'line-bounded-candidate',
            setup(plugin) {
              plugin.onLoad({ filter: /monaco-markdown-doc-link-decorations\.ts$/ }, () => ({
                contents: source.replace(replacement, current),
                loader: 'ts',
                resolveDir: fileURLToPath(
                  new URL('../../src/renderer/src/components/editor/', import.meta.url)
                )
              }))
            }
          }
        ]
      : []
  })
  return (
    await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
    )
  ).getMarkdownDocLinkDecorationRanges
}
const baseline = await load(true)
const candidate = await load(false)
const corpus = [
  '',
  '\n```\n[[hidden.md]]\n```\n[[shown.md]]',
  ' \t\r\n~~~\r\n[[hidden.md]]\r\n~~~\r\n[[shown.md]]',
  '\u00a0\u2028```\n[[hidden.md]]\n```\n[[shown.md]]',
  '`code` [[shown.md]]'
]
for (const content of corpus) {
  assert.deepEqual(candidate(content), baseline(content))
}
const scenarios = [
  ['ordinary-100k-lines', 'ordinary prose\n'.repeat(100_000)],
  ['blank-10k-lines', '\n'.repeat(10_000)],
  ['blank-30k-lines', '\n'.repeat(30_000)],
  ['blank-100k-lines', '\n'.repeat(100_000)],
  ['indented-blank-10k-lines', `${' '.repeat(80)}\n`.repeat(10_000)]
]
for (const [name, content] of scenarios) {
  const samples = { baseline: [], candidate: [] }
  const scanners = { baseline, candidate }
  let expected
  for (const arms of buildCounterbalancedSchedule(2, 'baseline', 'candidate')) {
    for (const arm of arms) {
      const started = performance.now()
      const ranges = scanners[arm](content)
      samples[arm].push(performance.now() - started)
      expected ??= ranges
      assert.deepEqual(ranges, expected)
    }
  }
  console.log(
    JSON.stringify({
      name,
      bytes: Buffer.byteLength(content),
      samples,
      baseline: summarizeBenchmarkSamples(samples.baseline),
      candidate: summarizeBenchmarkSamples(samples.candidate)
    })
  )
}
