#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { performance } from 'node:perf_hooks'

// Pass the pre-change source saved with git show <base>:src/shared/relay-frame-buffer.ts.
const baselinePath = process.argv[2]
if (!baselinePath) {
  throw new Error('Usage: node config/scripts/relay-frame-buffer-benchmark.mjs <baseline.ts>')
}
async function load(source) {
  return (
    await import(
      `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`
    )
  ).RelayFrameBuffer
}
const Before = await load(readFileSync(baselinePath, 'utf8'))
const After = await load(
  readFileSync(new URL('../../src/shared/relay-frame-buffer.ts', import.meta.url), 'utf8')
)
function median(values) {
  return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
}
for (const count of [1, 256, 16384, 65536]) {
  const chunks = Array.from({ length: count }, (_, index) => Buffer.alloc(64, index % 256))
  const expected = Buffer.concat(chunks)
  for (const mode of ['take', 'discard']) {
    const times = [[], []]
    for (let round = 0; round < 9; round += 1) {
      for (const arm of round % 2 === 0 ? [0, 1] : [1, 0]) {
        const FrameBuffer = arm === 0 ? Before : After
        const buffer = new FrameBuffer()
        for (const chunk of chunks) {
          buffer.append(chunk)
        }
        const start = performance.now()
        const output = buffer[mode](expected.length)
        times[arm].push(performance.now() - start)
        if (mode === 'take') {
          assert.deepEqual(output, expected)
        }
        assert.equal(buffer.length, 0)
        buffer.append(Buffer.from('tail'))
        assert.equal(buffer.drain().toString(), 'tail')
      }
    }
    const beforeMs = median(times[0]),
      afterMs = median(times[1])
    console.log(
      JSON.stringify({
        mode,
        chunks: count,
        bytes: expected.length,
        beforeMs,
        afterMs,
        speedup: beforeMs / afterMs
      })
    )
  }
}
