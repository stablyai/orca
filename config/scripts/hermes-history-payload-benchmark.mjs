#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../..', import.meta.url))
const fixture = await mkdtemp(join(tmpdir(), 'orca-hermes-payload-'))
const previousHome = process.env.HERMES_HOME
try {
  process.env.HERMES_HOME = fixture
  const bundle = join(fixture, 'benchmark.cjs')
  await build({
    stdin: {
      contents: `export { HermesRunHistory } from './src/relay/hermes-run-history'; export { prepareJsonRpcPayload } from './src/relay/protocol';`,
      resolveDir: root
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle
  })
  const { HermesRunHistory, prepareJsonRpcPayload } = createRequire(import.meta.url)(bundle)
  const outputDir = join(fixture, 'cron', 'output', 'job-1')
  await mkdir(outputDir, { recursive: true })
  const logPath = join(fixture, 'run.log')
  await writeFile(logPath, 'x'.repeat(5 * 1024 * 1024))
  for (let day = 1; day <= 25; day++) {
    await writeFile(
      join(outputDir, `2026-09-${String(day).padStart(2, '0')}_09-00-00.md`),
      `# Cron Job: benchmark\n## Response\nLatest log path: ${logPath}\nRun summary: completed\n`
    )
  }
  for (const pageSize of [1, 4, 8, 25]) {
    const history = new HermesRunHistory()
    const start = performance.now()
    const result = await history.listRuns({ provider: 'hermes', jobId: 'job-1', pageSize })
    const listMs = performance.now() - start
    assert.equal(result.runs.length, pageSize)
    const encodedStart = performance.now()
    const bytes = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
    const stringifyMs = performance.now() - encodedStart
    let transportError = null
    try {
      prepareJsonRpcPayload({ jsonrpc: '2.0', id: 1, result })
    } catch (error) {
      transportError = error.message
    }
    assert.equal(transportError !== null, pageSize >= 4)
    const summaryStart = performance.now()
    const summaryResult = await history.listRuns({
      provider: 'hermes',
      jobId: 'job-1',
      pageSize,
      summaryOnly: true
    })
    const summaryMs = performance.now() - summaryStart
    assert.equal(summaryResult.runs.length, pageSize)
    assert.ok(
      summaryResult.runs.every((run) => run.output_content === null && run.output_content_deferred)
    )
    const summaryPayload = prepareJsonRpcPayload({ jsonrpc: '2.0', id: 1, result: summaryResult })
    const detail = await history.listRuns({
      provider: 'hermes',
      jobId: 'job-1',
      runId: summaryResult.runs[0].id
    })
    assert.deepEqual(detail.runs, [result.runs[0]])
    prepareJsonRpcPayload({ jsonrpc: '2.0', id: 1, result: detail })
    console.log(
      JSON.stringify({
        pageSize,
        bytes,
        listMs,
        stringifyMs,
        transportError,
        summaryMs,
        summaryBytes: summaryPayload.byteLength
      })
    )
  }
} finally {
  if (previousHome === undefined) {
    delete process.env.HERMES_HOME
  } else {
    process.env.HERMES_HOME = previousHome
  }
  await rm(fixture, { recursive: true, force: true })
}
