import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { performance } from 'node:perf_hooks'
import { redactString } from '../../src/main/observability/redactor.ts'

// Supply an unchanged redactor.ts snapshot to measure the actual previous production function.
const baselinePath = process.argv[2]
if (!baselinePath) {
  throw new Error(
    'Usage: node config/scripts/redactor-environment-lines-benchmark.mjs <baseline-redactor.ts>'
  )
}
const baselineSource = stripTypeScriptTypes(readFileSync(baselinePath, 'utf8'))
const { redactString: before } = await import(
  `data:text/javascript;base64,${Buffer.from(baselineSource).toString('base64')}`
)
function median(fn, input, repeats) {
  const samples = []
  for (let run = 0; run < repeats; run++) {
    const started = performance.now()
    fn(input)
    samples.push(performance.now() - started)
  }
  return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]
}
const rows = []
for (const [shape, input] of [
  ['8KiB blank lines', '\n'.repeat(8192)],
  ['16KiB blank lines', '\n'.repeat(16384)],
  ['32KiB blank lines', '\n'.repeat(32768)],
  ['32KiB blank lines then invalid key', `${'\n'.repeat(32768)}lowercase`],
  ['ordinary env', 'FOO=value\nBAR=other\n'],
  ['ordinary message', 'Cannot read directory /workspace/source: file not found']
]) {
  assert.equal(redactString(input), before(input))
  const beforeMs = median(before, input, 3)
  const afterMs = median(redactString, input, 15)
  rows.push({
    shape,
    bytes: Buffer.byteLength(input),
    beforeMs,
    afterMs,
    speedup: beforeMs / afterMs
  })
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, rows }, null, 2))
