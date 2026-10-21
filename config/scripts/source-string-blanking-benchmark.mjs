import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { performance } from 'node:perf_hooks'
import { blankStringContents as after } from '../../src/shared/source-scan/source-tree-scan.ts'

const ref = process.argv[2]
if (!ref) {
  throw new Error('Usage: node config/scripts/source-string-blanking-benchmark.mjs <baseline-ref>')
}
const source = execFileSync('git', ['show', `${ref}:src/shared/source-scan/source-tree-scan.ts`], {
  encoding: 'utf8'
})
const { blankStringContents: before } = await import(
  `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`
)
const tokens = [
  'a',
  '/',
  '*',
  ' ',
  '\n',
  '\r',
  '\t',
  '\u00a0',
  '\u2028',
  '"',
  "'",
  '`',
  '${',
  '}',
  '{',
  '\\',
  '(',
  ')',
  '[',
  ']',
  '=',
  '+',
  '-',
  ';'
]
let seed = 173
for (let sample = 0; sample < 3000; sample++) {
  let input = ''
  for (let token = 0; token < 40; token++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    input += tokens[seed % tokens.length]
  }
  assert.equal(after(input), before(input), JSON.stringify(input))
  assert.equal(after(input, true), before(input, true), JSON.stringify(input))
}
function measure(fn, input) {
  const samples = []
  for (let run = 0; run < 3; run++) {
    const start = performance.now()
    fn(input)
    samples.push(performance.now() - start)
  }
  return samples.sort((a, b) => a - b)[1]
}
const results = []
for (const lines of [100, 1000, 5000, 10000]) {
  const input = 'const x = value / 2;\n'.repeat(lines)
  assert.equal(after(input), before(input))
  results.push({
    lines,
    bytes: Buffer.byteLength(input),
    beforeMs: measure(before, input),
    afterMs: measure(after, input)
  })
}
console.log(
  JSON.stringify(
    { node: process.version, platform: process.platform, differentialCases: 3000, results },
    null,
    2
  )
)
