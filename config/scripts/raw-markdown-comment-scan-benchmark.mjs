import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

const baseline = process.argv[2] ?? '20ab9950654'
const historicalFile = 'src/renderer/src/components/editor/raw-markdown-html.ts'
const file = 'src/renderer/src/components/editor/rich-markdown/raw-source/raw-markdown-html.ts'
async function load(contents, sourceFile = file) {
  const result = await build({
    stdin: {
      contents: `${contents}\nexport { createRichMarkdownEditorCodec } from ${JSON.stringify(resolve('src/renderer/src/components/editor/rich-markdown/document/rich-markdown-source-transport.ts'))}`,
      loader: 'ts',
      resolveDir: dirname(resolve(sourceFile))
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: [
      {
        name: 'historical-entry-dependencies',
        setup(bundler) {
          const historicalDependencies = new Map([
            [
              './details-markdown-html',
              resolve(
                'src/renderer/src/components/editor/rich-markdown/details/details-markdown-html.ts'
              )
            ],
            [
              './markdown-doc-links',
              resolve('src/renderer/src/components/editor/markdown/documents/markdown-doc-links.ts')
            ],
            [
              './markdown-reference-link-normalization',
              resolve(
                'src/renderer/src/components/editor/markdown/source-scanning/markdown-reference-link-normalization.ts'
              )
            ],
            [
              './rich-markdown-source-transport',
              resolve(
                'src/renderer/src/components/editor/rich-markdown/document/rich-markdown-source-transport.ts'
              )
            ],
            [
              './rich-markdown-html-superscript-link-source',
              resolve(
                'src/renderer/src/components/editor/rich-markdown/citations/rich-markdown-html-superscript-link-source.ts'
              )
            ]
          ])
          bundler.onResolve({ filter: /^\.\// }, (args) => {
            if (sourceFile !== historicalFile || args.importer !== '<stdin>') {
              return
            }
            const resolvedPath = historicalDependencies.get(args.path)
            return resolvedPath ? { path: resolvedPath } : undefined
          })
        }
      }
    ],
    banner: {
      js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(resolve('package.json'))});`
    }
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  )
}
const arms = {
  before: await load(
    execFileSync('git', ['show', `${baseline}:${historicalFile}`], {
      encoding: 'utf8',
      windowsHide: true
    }),
    historicalFile
  ),
  after: await load(readFileSync(file, 'utf8'))
}
const key = '0123456789abcdef0123456789abcdef'
const codecs = Object.fromEntries(
  Object.entries(arms).map(([arm, module]) => [arm, module.createRichMarkdownEditorCodec(key)])
)
const results = []
for (const [name, input] of [
  ['plain', '# Heading\nOrdinary prose.'],
  ['complete', 'before <!--metadata--> after <b>text</b>\n'.repeat(100)],
  ['unclosed-1000', `prefix ${'<!--x'.repeat(1000)}`],
  ['unclosed-8000', `prefix ${'<!--x'.repeat(8000)} <b>tail</b>`],
  ['mixed-8000', `prefix <!--complete-->${'<!--x'.repeat(8000)} <b>tail</b>`],
  ['protected', '\\<!--x `<!--x`\n```html\n<!--x\n```\n'],
  ['transport', `before [[ORCA_RICH_MD:${key}:inline-html:%3Cb%3E]] and [[README.md]]`]
]) {
  for (const htmlSuperscriptLinks of [false, true]) {
    const options = { htmlSuperscriptLinks }
    const invoke = (arm) =>
      arms[arm].encodeRawMarkdownHtmlForRichEditor(input, codecs[arm], options)
    assert.equal(invoke('after'), invoke('before'))
    const iterations = name.includes('8000') || name.includes('1000') ? 2 : 100
    function run(arm) {
      global.gc?.()
      const start = performance.now()
      const cpuStart = process.cpuUsage()
      for (let i = 0; i < iterations; i++) {
        invoke(arm)
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
      htmlSuperscriptLinks,
      beforeCpuMs: median(samples.before.map((s) => s.cpuMs)),
      afterCpuMs: median(samples.after.map((s) => s.cpuMs)),
      beforeMs: median(samples.before.map((s) => s.ms)),
      afterMs: median(samples.after.map((s) => s.ms)),
      samples
    })
  }
}
console.log(
  JSON.stringify({ baseline, node: process.version, platform: process.platform, results }, null, 2)
)
