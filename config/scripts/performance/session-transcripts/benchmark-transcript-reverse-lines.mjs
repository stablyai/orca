import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import Module from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'

const entry = 'src/shared/agent-hook-listener/transcript-reader.ts'
assert.ok(process.argv[2], 'Pass a pre-change transcript-reader.ts snapshot.')
const baseline = readFileSync(process.argv[2], 'utf8')
assert.notEqual(baseline, readFileSync(entry, 'utf8'), 'Do not compare the source to itself.')

async function load(useBaseline) {
  const result = await build({
    stdin: {
      contents: `export * from './${entry}';
export { extractAssistantTextFromLine } from './src/shared/agent-hook-listener/transcript-entry-text.ts';`,
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
    plugins: useBaseline
      ? [
          {
            name: 'baseline-transcript-reader',
            setup(builder) {
              builder.onLoad({ filter: /transcript-reader\.ts$/ }, () => ({
                contents: baseline,
                loader: 'ts'
              }))
            }
          }
        ]
      : []
  })
  const module = new Module(resolve('transcript-benchmark.cjs'))
  module.paths = Module._nodeModulePaths(process.cwd())
  module._compile(result.outputFiles[0].text, module.id)
  return module.exports
}

const versions = [await load(true), await load(false)]
function measure(functions, iterations) {
  let sink = 0
  const run = (fn) => {
    for (let i = 0; i < iterations; i++) {
      sink += fn()?.length ?? 0
    }
  }
  for (const fn of functions) {
    for (let i = 0; i < 3; i++) {
      run(fn)
    }
  }
  const samples = [[], []]
  for (let round = 0; round < 11; round++) {
    for (const index of round % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now()
      run(functions[index])
      samples[index].push((performance.now() - start) / iterations)
    }
  }
  return {
    beforeMs: samples[0].sort((a, b) => a - b)[5],
    afterMs: samples[1].sort((a, b) => a - b)[5],
    iterations,
    sink
  }
}

const cases = [
  ['tiny', `${JSON.stringify({ role: 'assistant', content: 'hello' })}\n`, 10000],
  ['64KiB line', `${JSON.stringify({ role: 'assistant', content: 'x'.repeat(65500) })}\n`, 100],
  [
    '4MiB line',
    `${JSON.stringify({ role: 'assistant', content: 'x'.repeat(4 * 1024 * 1024 - 40) })}\n`,
    10
  ],
  [
    '1000 short tool lines',
    Array.from({ length: 1000 }, () =>
      JSON.stringify({ role: 'tool', content: 'x'.repeat(100) })
    ).join('\n'),
    50
  ],
  [
    'Unicode line',
    `${JSON.stringify({ role: 'assistant', content: '😀漢字'.repeat(16000) })}\n`,
    100
  ],
  [
    'leading and trailing blank lines',
    `\n\r\n${JSON.stringify({ role: 'assistant', content: 'hello' })}\n\n`,
    10000
  ]
]
const directory = mkdtempSync(join(tmpdir(), 'orca-transcript-benchmark-'))
try {
  for (const [name, text, iterations] of cases) {
    const file = join(directory, 'transcript.jsonl')
    writeFileSync(file, text)
    const scanners = versions.map(
      (v) => () => v.findLastExtractedTranscriptLineText(text, v.extractAssistantTextFromLine)
    )
    const readers = versions.map((v) => () => v.readLastAssistantFromTranscriptOnce(file))
    assert.equal(scanners[0](), scanners[1](), name)
    assert.equal(readers[0](), readers[1](), name)
    console.log(
      JSON.stringify({
        name,
        bytes: Buffer.byteLength(text),
        scanner: measure(scanners, iterations),
        warmFileReader: measure(readers, Math.min(iterations, 100))
      })
    )
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
