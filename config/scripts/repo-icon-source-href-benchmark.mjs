import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { extractIconHref } from '../../src/main/repo-icon-source-href.ts'

// Original production expressions, preserved for the before/after measurement.
const html =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i
const object =
  /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i
const original = (source) => source.match(html)?.[1] ?? source.match(object)?.[1] ?? null

function measurePair(source) {
  original(source)
  extractIconHref(source)
  const beforeSamples = []
  const afterSamples = []
  for (let run = 0; run < 5; run++) {
    const measurements = [
      [original, beforeSamples],
      [extractIconHref, afterSamples]
    ]
    if (run % 2 === 1) {
      measurements.reverse()
    }
    for (const [fn, samples] of measurements) {
      const started = performance.now()
      fn(source)
      samples.push(performance.now() - started)
    }
  }
  return {
    beforeMs: beforeSamples.sort((a, b) => a - b)[2],
    afterMs: afterSamples.sort((a, b) => a - b)[2]
  }
}

const results = []
for (const size of [8192, 16384, 32768]) {
  for (const shape of ['no icon', 'rel without href', 'unterminated link starts']) {
    const source =
      shape === 'unterminated link starts'
        ? '<link '.repeat(Math.floor(size / 6))
        : 'a'.repeat(size) + (shape === 'rel without href' ? ' rel:"icon"' : '')
    assert.equal(extractIconHref(source), original(source))
    const { beforeMs, afterMs } = measurePair(source)
    results.push({
      shape,
      bytes: Buffer.byteLength(source),
      beforeMs,
      afterMs,
      speedup: beforeMs / afterMs
    })
  }
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2))
