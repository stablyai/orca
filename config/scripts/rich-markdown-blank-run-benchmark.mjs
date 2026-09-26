#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const entry = join(root, 'src/renderer/src/components/editor/raw-markdown-html.ts')
const source = await readFile(entry, 'utf8')
const cachedProbe =
  /if \(index > fenceProbe\) \{[\s\S]*?fenceMatch = fencePrefix.exec\(normalizedContent\)\n      \}/
assert.match(source, cachedProbe)
const oldProbe = String.raw`fenceMatch = normalizedContent.slice(index).match(/^\s*(\x60{3,}|~{3,})/)`
const temp = await mkdtemp(join(tmpdir(), 'orca-rich-blank-bench-'))
try {
  const scanners = {}
  for (const arm of ['baseline', 'current']) {
    const outfile = join(temp, `${arm}.cjs`)
    await build({
      stdin: {
        contents: `export { encodeRawMarkdownHtmlForRichEditor as encode } from './src/renderer/src/components/editor/raw-markdown-html'; export { createRichMarkdownEditorCodec as codec } from './src/renderer/src/components/editor/rich-markdown-source-transport';`,
        resolveDir: root
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
      plugins:
        arm === 'baseline'
          ? [
              {
                name: 'old-probe',
                setup(plugin) {
                  plugin.onLoad({ filter: /raw-markdown-html\.ts$/ }, () => ({
                    contents: source.replace(cachedProbe, oldProbe),
                    loader: 'ts',
                    resolveDir: join(root, 'src/renderer/src/components/editor')
                  }))
                }
              }
            ]
          : []
    })
    const { encode, codec } = createRequire(import.meta.url)(outfile)
    scanners[arm] = (content) => encode(content, codec('0'.repeat(32)))
  }
  const fragments = [
    '\n',
    ' \r\n',
    '\u00a0\u2028',
    '```\n',
    '~~~~\n',
    '<div>\n',
    '</div>\n',
    '[[doc.md]]\n',
    '`inline`\n',
    'prose\n'
  ]
  let seed = 42
  for (let sample = 0; sample < 256; sample++) {
    let content = ''
    for (let i = 0; i < 20; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      content += fragments[seed % fragments.length]
    }
    assert.equal(scanners.current(content), scanners.baseline(content))
  }
  for (const [name, content] of [
    ['ordinary', 'ordinary prose\n'.repeat(10000)],
    ['blank-100k', '\n'.repeat(100000)],
    ['blank-before-fence', `${'\n'.repeat(30000)}\x60\x60\x60\n<div>\n\x60\x60\x60\n[[doc.md]]`]
  ]) {
    const samples = { baseline: [], current: [] }
    let expected
    for (const arms of buildCounterbalancedSchedule(2, 'baseline', 'current')) {
      for (const arm of arms) {
        const start = performance.now()
        const result = scanners[arm](content)
        samples[arm].push(performance.now() - start)
        expected ??= result
        assert.equal(result, expected)
      }
    }
    console.log(
      JSON.stringify({
        name,
        bytes: Buffer.byteLength(content),
        samples,
        baseline: summarizeBenchmarkSamples(samples.baseline),
        current: summarizeBenchmarkSamples(samples.current)
      })
    )
  }
} finally {
  await rm(temp, { recursive: true, force: true })
}
