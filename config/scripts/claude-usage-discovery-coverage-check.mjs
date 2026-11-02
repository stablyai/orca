#!/usr/bin/env node
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  loadClaudeUsageBenchmarkScanner,
  readClaudeUsageBenchmarkBaselineSources
} from './claude-usage-benchmark-scanner.mjs'

const { values } = parseArgs({
  options: {
    'baseline-ref': { type: 'string', default: '51e7181850b022bae2d41091fe1229accef4bd50' },
    output: { type: 'string' }
  }
})
process.env.ORCA_CLAUDE_USAGE_APPEND_BENCH_BASELINE = values['baseline-ref']

function writeReport(report) {
  console.log(JSON.stringify(report))
  return values.output
    ? writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`)
    : Promise.resolve()
}

if (process.platform === 'win32' || process.getuid?.() === 0) {
  await writeReport({
    purpose: 'Real filesystem permission denial check.',
    skipped: true,
    reason:
      process.platform === 'win32'
        ? 'POSIX chmod does not deny Windows ACL access; mocked EACCES contracts cover Windows.'
        : 'Root can read chmod-denied directories; mocked EACCES contracts cover privileged runs.',
    platform: process.platform
  })
} else {
  const home = await mkdtemp(join(tmpdir(), 'orca-claude-discovery-coverage-'))
  const denied = join(home, '.claude', 'projects', 'denied')
  try {
    const project = join(home, '.claude', 'projects', 'valid')
    await mkdir(project, { recursive: true })
    await mkdir(denied)
    await writeFile(
      join(project, 'session.jsonl'),
      `${JSON.stringify({
        type: 'assistant',
        sessionId: 'session',
        timestamp: '2026-10-09T00:00:00Z',
        message: { id: 'message', usage: { input_tokens: 10, output_tokens: 1 } }
      })}\n`
    )
    const baseline = await readClaudeUsageBenchmarkBaselineSources()
    const loaded = await Promise.all([
      loadClaudeUsageBenchmarkScanner(home, baseline.sources, new Map(), baseline.baselineCommit),
      loadClaudeUsageBenchmarkScanner(home)
    ])
    const arms = {}
    for (const [index, arm] of ['baseline', 'current'].entries()) {
      const { scanner, bundleSha256, sourceFingerprints } = loaded[index]
      const complete = await scanner.scanClaudeUsageFiles([], [], undefined, [])
      assert.equal(complete.processedFiles.length, 1)
      await chmod(denied, 0)
      let outcome
      try {
        const result = await scanner.scanClaudeUsageFiles(
          [],
          complete.processedFiles,
          undefined,
          []
        )
        outcome = {
          resolved: true,
          processedFiles: result.processedFiles.length,
          sessions: result.sessions.length
        }
      } catch (error) {
        outcome = {
          resolved: false,
          code: error.code ?? null,
          message: error.message.replace(home, '<fixture-home>')
        }
      } finally {
        await chmod(denied, 0o700)
      }
      const recovered = await scanner.scanClaudeUsageFiles(
        [],
        complete.processedFiles,
        undefined,
        []
      )
      assert.deepEqual(recovered.sessions, complete.sessions)
      arms[arm] = {
        baselineProcessedFiles: complete.processedFiles.length,
        outcome,
        recoveredProcessedFiles: recovered.processedFiles.length,
        bundleSha256,
        sourceFingerprints
      }
    }
    assert.deepEqual(arms.baseline.outcome, { resolved: true, processedFiles: 0, sessions: 0 })
    assert.equal(
      arms.current.outcome.resolved,
      false,
      'unreadable history must not publish empty totals'
    )
    assert.equal(arms.current.outcome.code, 'EACCES')
    await writeReport({
      purpose: 'Actual bundled scanner under a real unreadable sibling directory; no timing claim.',
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      baselineRef: baseline.baselineRef,
      baselineCommit: baseline.baselineCommit,
      existingCacheSupplied: true,
      exactRecoveryParity: true,
      toolingSha256: createHash('sha256')
        .update(await readFile(import.meta.filename))
        .digest('hex'),
      arms
    })
  } finally {
    await chmod(denied, 0o700).catch(() => {})
    await rm(home, { recursive: true, force: true })
  }
}
