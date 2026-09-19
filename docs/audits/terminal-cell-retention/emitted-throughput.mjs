import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1')
}
assert.ok(
  process.env.ORCA_AUDIT_HEADLESS_BASELINE,
  'Set ORCA_AUDIT_HEADLESS_BASELINE to the pristine CJS bundle'
)
const require = createRequire(import.meta.url)
const variants = [
  ['baseline', process.env.ORCA_AUDIT_HEADLESS_BASELINE],
  ['patched', require.resolve('@xterm/headless')]
].map(([name, bundle]) => {
  const { Terminal } = require(bundle)
  return {
    name,
    sha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
    terminal: new Terminal({
      cols: 120,
      rows: 40,
      scrollback: 0,
      allowProposedApi: true,
      logLevel: 'off'
    }),
    timings: []
  }
})
const text = `${'a'.repeat(118)}\r\n`.repeat(10_000)
const writesPerRound = 8
try {
  for (let round = 0; round < 14; round++) {
    const order = round % 2 === 0 ? variants : variants.toReversed()
    for (const variant of order) {
      const start = performance.now()
      for (let write = 0; write < writesPerRound; write++) {
        variant.terminal._core.writeSync(text)
      }
      variant.timings.push(Math.round(((performance.now() - start) / writesPerRound) * 100) / 100)
    }
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        bytesPerRound: text.length,
        writesPerRound,
        discardedWarmupRounds: 4,
        results: variants.map(({ name, sha256, timings }) => {
          const sorted = timings.slice(4).sort((a, b) => a - b)
          return { name, sha256, timings, medianMs: (sorted[4] + sorted[5]) / 2 }
        }),
        limits:
          'Actual pristine and patched CJS headless bundles. Sequential synthetic ASCII writes; no app, filesystem, provider or renderer overhead. Timing noise is not application-wide performance evidence.'
      },
      null,
      2
    )
  )
} finally {
  for (const variant of variants) {
    variant.terminal.dispose()
  }
}
