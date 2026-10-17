import assert from 'node:assert/strict'
import { runProcessSync } from '@orca/process-host'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

// Both arms use the production encoder; only the reference normalizer is replaced.
const baseline = process.argv[2] ?? '13a75d3939f60bbc5ebf3bc083fe31fe74813168'
const file = 'src/renderer/src/components/editor/markdown-reference-link-normalization.ts'
const editorDirectory = dirname(resolve(file))
const extracted = runProcessSync({
  program: 'git',
  args: ['show', `${baseline}:${file}`],
  cwd: process.cwd(),
  timeoutMs: 30_000
})
assert.equal(extracted.timedOut, false, 'baseline extraction timed out')
assert.equal(extracted.code, 0, extracted.stderr)
const sources = {
  before: extracted.stdout,
  after: readFileSync(file, 'utf8')
}
const visitLoop = 'for (let index = start; index < content.length; index += 1) {'
const countLoop = `${visitLoop}\n globalThis.__orcaReferenceBracketVisits += 1`
const entry = `
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { normalizeMarkdownReferenceLinks } from './markdown-reference-link-normalization'
const codec = createRichMarkdownEditorCodec('0123456789abcdef0123456789abcdef')
export const encode = (source) => encodeRawMarkdownHtmlForRichEditor(source, codec)
export { normalizeMarkdownReferenceLinks }
`

async function load(source, countVisits = false) {
  if (countVisits) {
    assert.equal(source.split(visitLoop).length, 2, 'the closing-bracket loop must be unique')
  }
  const result = await build({
    stdin: { contents: entry, loader: 'ts', resolveDir: editorDirectory },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: [
      {
        name: 'reference-normalizer-source',
        setup(bundler) {
          bundler.onLoad({ filter: /markdown-reference-link-normalization\.ts$/ }, () => ({
            contents: countVisits ? source.replace(visitLoop, countLoop) : source,
            loader: 'ts'
          }))
        }
      }
    ]
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  )
}

const arms = {
  before: await load(sources.before),
  after: await load(sources.after)
}
const definition = '\n\n[ref]: https://example.com/ref "Reference"\n'
const unfinished = (count) => `${'[todo '.repeat(count)}${definition}`
const fixtures = [
  [
    'ordinary-no-definitions',
    'Ordinary prose with `code` and [inline](https://example.com).\n'.repeat(700)
  ],
  [
    'ordinary-unused-definition',
    `Ordinary prose with [inline](https://example.com).\n`.repeat(700) + definition
  ],
  ['complete-references', '[ref] and [caption][ref] and [caption][]\n'.repeat(700) + definition],
  ['unfinished-2000', unfinished(2000)],
  ['unfinished-8000', unfinished(8000)],
  ['unfinished-32000', unfinished(32000)],
  ['complete-before-tail', `[ref]\n${unfinished(32000)}`],
  ['escaped-closing-tail', `${'[todo \\] '.repeat(8000)}${definition}`],
  ['fenced-tail', `\`\`\`md\n${'[todo '.repeat(8000)}\n\`\`\`\n${definition}`]
]
let seed = 0x726566
const random = (limit) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed % limit
}
const pieces = [
  '[',
  ']',
  '\\]',
  '\\\\]',
  '[ref]',
  '[caption][ref]',
  '[ref][unfinished',
  '\n',
  'text ',
  '```\n',
  '[inline](url)',
  '`[ref]`'
]
for (let sample = 0; sample < 512; sample++) {
  let source = ''
  for (let part = 0; part < 24; part++) {
    source += pieces[random(pieces.length)]
  }
  source += definition
  assert.equal(arms.after.encode(source), arms.before.encode(source), `parity sample ${sample}`)
}

const countedArms = {
  before: await load(sources.before, true),
  after: await load(sources.after, true)
}
const operationCounts = []
for (const [name, source] of [
  ['unfinished', unfinished(2000)],
  ['escaped-closing-tail', `${'[todo \\] '.repeat(2000)}${definition}`],
  ['unfinished-label-before-shortcut', `[not-a-reference][unfinished [ref]${definition}`]
]) {
  const visits = {}
  const output = {}
  for (const arm of ['before', 'after']) {
    globalThis.__orcaReferenceBracketVisits = 0
    output[arm] = countedArms[arm].normalizeMarkdownReferenceLinks(source)
    visits[arm] = globalThis.__orcaReferenceBracketVisits
  }
  assert.equal(output.after, output.before)
  if (name !== 'unfinished-label-before-shortcut') {
    assert.ok(visits.after <= source.length, `current count budget failed: ${name}`)
    assert.ok(visits.before > source.length * 500, `baseline must fail the same budget: ${name}`)
  }
  operationCounts.push({ name, visits })
}
delete globalThis.__orcaReferenceBracketVisits

const results = []
for (const [name, source] of fixtures) {
  const invoke = (arm) => arms[arm].encode(source)
  const expected = invoke('before')
  assert.equal(invoke('after'), expected)
  for (let warmup = 0; warmup < 3; warmup++) {
    assert.equal(invoke('before'), expected)
    assert.equal(invoke('after'), expected)
  }
  const iterations = name.includes('32000') || name === 'complete-before-tail' ? 1 : 3
  const samples = { before: [], after: [] }
  for (const pair of buildCounterbalancedSchedule(8, 'before', 'after')) {
    for (const arm of pair) {
      global.gc?.()
      const cpuStart = process.cpuUsage()
      const start = performance.now()
      let output
      for (let iteration = 0; iteration < iterations; iteration++) {
        output = invoke(arm)
      }
      const ms = (performance.now() - start) / iterations
      const cpu = process.cpuUsage(cpuStart)
      assert.equal(output, expected)
      samples[arm].push({ ms, cpuMs: (cpu.user + cpu.system) / (iterations * 1000) })
    }
  }
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
  results.push({
    name,
    bytes: Buffer.byteLength(source),
    medianMs: {
      before: median(samples.before.map((sample) => sample.ms)),
      after: median(samples.after.map((sample) => sample.ms))
    },
    medianCpuMs: {
      before: median(samples.before.map((sample) => sample.cpuMs)),
      after: median(samples.after.map((sample) => sample.cpuMs))
    },
    samples
  })
}
console.log(
  JSON.stringify(
    {
      baseline,
      baselineExtraction: `git show ${baseline}:${file}`,
      sourceHashes: Object.fromEntries(
        Object.entries(sources).map(([arm, source]) => [
          arm,
          createHash('sha256').update(source).digest('hex')
        ])
      ),
      node: process.version,
      platform: process.platform,
      timing:
        'uninstrumented production encoder; eight alternating pairs; three warmups; output parity',
      countInstrumentation:
        'one counter increment per existing closing-bracket loop visit; excluded from timing',
      paritySamples: 512,
      operationCounts,
      results
    },
    null,
    2
  )
)
