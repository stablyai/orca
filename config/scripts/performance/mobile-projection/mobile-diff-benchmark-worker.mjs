import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { setImmediate } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const [bundlePath, scenario, countText] = process.argv.slice(2)
const count = Number(countText)
const {
  buildMobileDiffLines,
  buildMobileDiffReviewRows,
  highlightMobileDiffLines,
  resolveMobileSyntaxLanguage
} = await import(pathToFileURL(bundlePath).href)

function fixture() {
  const original = Array.from({ length: count }, (_, i) => `const value${i} = ${i};`)
  const modified = original.map((line, i) =>
    scenario === 'rewrite' || (scenario === 'scattered' && i % 20 === 0)
      ? `export const replacement${i} = "changed";`
      : line
  )
  modified[0] = 'const firstValue = "changed";'
  modified[count - 1] = 'const finalValue = "changed";'
  return { original: original.join('\n'), modified: modified.join('\n') }
}

const input = fixture()
const language = resolveMobileSyntaxLanguage('benchmark.ts')

function prepare() {
  const started = performance.now()
  const diff = buildMobileDiffLines(input.original, input.modified)
  const builtAt = performance.now()
  const lines = highlightMobileDiffLines(diff.lines, language)
  const rows = buildMobileDiffReviewRows(lines, new Set())
  return {
    truncated: diff.truncated,
    lines,
    rows,
    buildMs: builtAt - started,
    readyMs: performance.now() - started
  }
}

function warmup() {
  for (let i = 0; i < 2; i += 1) {
    prepare()
  }
}

function measure() {
  const before = process.memoryUsage()
  const result = prepare()
  globalThis.__orcaMobileDiffBenchmarkResult = result
  const after = process.memoryUsage()
  globalThis.gc()
  globalThis.gc()
  const retained = process.memoryUsage()
  const processPeakRssBytes = process.resourceUsage().maxRSS * 1024

  const finalEditPresent = result.lines.some(
    (line) => line.kind === 'add' && line.text === 'const finalValue = "changed";'
  )
  const original = result.lines
    .filter((line) => line.oldLineNumber !== undefined)
    .map((line) => line.text)
    .join('\n')
  const modified = result.lines
    .filter((line) => line.newLineNumber !== undefined)
    .map((line) => line.text)
    .join('\n')
  if (result.truncated) {
    assert.equal(input.original.startsWith(original), true)
    assert.equal(input.modified.startsWith(modified), true)
  } else {
    assert.equal(finalEditPresent, true)
    assert.equal(original, input.original)
    assert.equal(modified, input.modified)
  }
  return {
    buildMs: result.buildMs,
    readyMs: result.readyMs,
    before,
    after,
    retained,
    endHeapDeltaBytes: after.heapUsed - before.heapUsed,
    processPeakRssBytes,
    inputBytes: Buffer.byteLength(input.original) + Buffer.byteLength(input.modified),
    outputLines: result.lines.length,
    foldedRows: result.rows.length,
    truncated: result.truncated,
    finalEditPresent
  }
}

assert.equal(typeof globalThis.gc, 'function', 'Worker requires --expose-gc')
warmup()
await setImmediate()
globalThis.gc()
globalThis.gc()
const measurement = measure()
delete globalThis.__orcaMobileDiffBenchmarkResult
await setImmediate()
globalThis.gc()
globalThis.gc()
const released = process.memoryUsage()
process.stdout.write(
  `${JSON.stringify({
    ...measurement,
    released,
    retainedHeapDeltaBytes: measurement.retained.heapUsed - released.heapUsed,
    retainedArrayBufferDeltaBytes: measurement.retained.arrayBuffers - released.arrayBuffers
  })}\n`
)
