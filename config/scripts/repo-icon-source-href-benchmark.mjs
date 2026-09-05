import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { extractIconHref } from '../../src/main/repo-icon-source-href.ts'

// Original production expressions, preserved for the before/after measurement.
const html =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i
const object =
  /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i
const original = (source) => source.match(html)?.[1] ?? source.match(object)?.[1] ?? null

function measure(fn, source, repetitions) {
  const samples = []
  for (let run = 0; run < repetitions; run++) {
    const started = performance.now()
    fn(source)
    samples.push(performance.now() - started)
  }
  return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]
}

const results = []
for (const size of [8192, 16384, 32768]) {
  for (const shape of ['no icon', 'rel without href', 'unterminated link starts']) {
    const source =
      shape === 'unterminated link starts'
        ? '<link '.repeat(Math.floor(size / 6))
        : 'a'.repeat(size) + (shape === 'rel without href' ? ' rel:"icon"' : '')
    assert.equal(extractIconHref(source), original(source))
    const beforeMs = measure(original, source, 3)
    const afterMs = measure(extractIconHref, source, 15)
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
