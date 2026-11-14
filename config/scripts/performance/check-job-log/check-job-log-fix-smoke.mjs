import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createManifest } from './check-job-log-performance-cases.mjs'
import { prepareBenchmark, runDescriptor, hash } from './check-job-log-byte-cap-benchmark.mjs'

assert(process.env.ORCA_CHECK_LOG_SMOKE_REPORT)
const context = await prepareBenchmark()
const manifest = createManifest({
  capturePath: process.env.ORCA_CHECK_LOG_CAPTURE
}).filter(
  (item) => item.mode === 'cpu' && ['baseline', 'proposed'].includes(item.arm) && item.sample < 3
)
const records = []
try {
  for (const descriptor of manifest) {
    records.push(await runDescriptor(context, descriptor))
  }
  await writeFile(
    process.env.ORCA_CHECK_LOG_SMOKE_REPORT,
    JSON.stringify(
      {
        purpose:
          'Selected three-sample CPU smoke; final prescribed medians and audit remain pending',
        identity: context.identity,
        selectionScriptHash: hash(await readFile(new URL(import.meta.url))),
        records
      },
      null,
      2
    )
  )
  console.log(JSON.stringify({ completed: records.length }))
} finally {
  await context.cleanup()
}
