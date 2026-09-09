import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'

const sourcePath = 'mobile/src/components/mobile-markdown-preview-html.ts'
const baselineRef = process.argv[2]
if (!baselineRef) {
  throw new Error(
    'Usage: node config/scripts/mobile-markdown-placeholder-benchmark.mjs <baseline-ref>'
  )
}
async function load(source) {
  const result = await build({
    stdin: { contents: source, resolveDir: dirname(resolve(sourcePath)), loader: 'ts' },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm'
  })
  return (
    await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
    )
  ).normalizeMobileMarkdownPreviewHtml
}
const before = await load(
  execFileSync('git', ['show', `${baselineRef}:${sourcePath}`], { encoding: 'utf8' })
)
const after = await load(readFileSync(sourcePath, 'utf8'))
function measure(fn, input, repeats) {
  const samples = []
  for (let run = 0; run < repeats; run++) {
    const start = performance.now()
    fn(input)
    samples.push(performance.now() - start)
  }
  return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]
}
const results = []
for (const [shape, input] of [
  ['ordinary Markdown', '# Hello\n\n<p>Use `Array<string>` and <b>bold</b>.</p>'],
  ...[2048, 8192, 16384].map((length) => [
    `${length} underscore collision`,
    `\uE000ORCA_MD_CODE_${'_'.repeat(length)}0\uE000 and \`Array<string>\``
  ])
]) {
  assert.equal(after(input), before(input))
  results.push({
    shape,
    bytes: Buffer.byteLength(input),
    beforeMs: measure(before, input, 5),
    afterMs: measure(after, input, 15)
  })
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2))
