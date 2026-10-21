#!/usr/bin/env node
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { runProcessSync } from '@orca/process-host'
import {
  loadClaudeUsageBenchmarkScanner,
  readClaudeUsageBenchmarkBaselineSources
} from './claude-usage-benchmark-scanner.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const STORE_PATH = 'src/main/claude-usage/store.ts'
const { values } = parseArgs({
  options: {
    'baseline-ref': { type: 'string', default: '51e7181850b022bae2d41091fe1229accef4bd50' },
    'usage-keys': { type: 'string', default: '16384' },
    output: { type: 'string' }
  }
})
const usageKeys = Number(values['usage-keys'])
assert(
  Number.isSafeInteger(usageKeys) && usageKeys > 7,
  'usage-keys must be an integer above seven'
)
process.env.ORCA_CLAUDE_USAGE_APPEND_BENCH_BASELINE = values['baseline-ref']

function serializationIndent(source) {
  const indent = /jsonIndent:\s*(\d+)/.exec(source)
  return indent ? Number(indent[1]) : undefined
}

function sourceHash(source) {
  return createHash('sha256').update(source).digest('hex')
}

function persistedState(result) {
  return {
    schemaVersion: 6,
    worktreeFingerprint: '[]',
    processedFiles: result.processedFiles,
    sessions: result.sessions,
    dailyAggregates: result.dailyAggregates,
    scanState: {
      enabled: true,
      lastScanStartedAt: 1,
      lastScanCompletedAt: 2,
      lastScanError: null
    }
  }
}

function usageRecord(cwd, index, inputTokens = 100) {
  return `${JSON.stringify({
    type: 'assistant',
    sessionId: 'active-session',
    timestamp: new Date(Date.UTC(2026, 9, 9, 12, 0, index)).toISOString(),
    requestId: `request-${index}`,
    cwd,
    gitBranch: 'benchmark',
    message: {
      id: `message-${index}`,
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: inputTokens,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 20,
        cache_creation: { ephemeral_1h_input_tokens: 5 }
      }
    }
  })}\n`
}

const home = await mkdtemp(join(tmpdir(), 'orca-claude-cache-representation-'))
try {
  const project = join(home, '.claude', 'projects', 'benchmark')
  const cwd = join(home, 'repo')
  await mkdir(project, { recursive: true })
  await mkdir(cwd)
  const transcriptPath = join(project, 'active-session.jsonl')
  const history = Array.from({ length: usageKeys }, (_, index) => usageRecord(cwd, index)).join('')
  const baseline = await readClaudeUsageBenchmarkBaselineSources()
  const storeRead = runProcessSync({
    program: 'git',
    args: ['show', `${baseline.baselineCommit}:${STORE_PATH}`],
    cwd: ROOT,
    timeoutMs: 10_000,
    maxOutputBytes: 1024 * 1024,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  })
  assert.equal(storeRead.code, 0, storeRead.stderr)
  const currentStore = await readFile(join(ROOT, ...STORE_PATH.split('/')), 'utf8')
  const stores = { baseline: storeRead.stdout, current: currentStore }
  const loaded = await Promise.all([
    loadClaudeUsageBenchmarkScanner(home, baseline.sources, new Map(), baseline.baselineCommit),
    loadClaudeUsageBenchmarkScanner(home)
  ])
  const arms = {}
  const results = []
  for (const [index, arm] of ['baseline', 'current'].entries()) {
    const { scanner, bundleSha256, sourceFingerprints } = loaded[index]
    await writeFile(transcriptPath, history)
    const cold = await scanner.scanClaudeUsageFiles([], [], undefined, [])
    await appendFile(transcriptPath, usageRecord(cwd, 7, 2_000))
    const result = await scanner.scanClaudeUsageFiles(
      [],
      JSON.parse(JSON.stringify(cold.processedFiles)),
      undefined,
      []
    )
    const fresh = await scanner.scanClaudeUsageFiles([], [], undefined, [])
    assert.deepEqual(result, fresh, `${arm} resume differs from a fresh scan`)
    assert.equal(result.processedFiles[0].ownedDedupeKeys.length, usageKeys)
    assert.equal(result.sessions[0].totalInputTokens, usageKeys * 100 + 1_900)
    const state = persistedState(result)
    const compact = JSON.stringify(state)
    const indented = JSON.stringify(state, null, 2)
    const indent = serializationIndent(stores[arm])
    assert.deepEqual(JSON.parse(compact), JSON.parse(indented))
    assert.deepEqual(structuredClone(state), state)
    arms[arm] = {
      compactFullStateBytes: Buffer.byteLength(compact),
      indentedFullStateBytes: Buffer.byteLength(indented),
      productionFullStateBytes: Buffer.byteLength(JSON.stringify(state, null, indent)),
      productionIndent: indent ?? null,
      storeSha256: sourceHash(stores[arm]),
      ownedKeys: result.processedFiles[0].ownedDedupeKeys.length,
      bundleSha256,
      sourceFingerprints
    }
    results.push(result)
  }
  assert.deepEqual(results[0].sessions, results[1].sessions)
  assert.deepEqual(results[0].dailyAggregates, results[1].dailyAggregates)
  const report = {
    purpose: 'Actual scanner cache representation byte counts; no timing or peak-memory claim.',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    baselineRef: baseline.baselineRef,
    baselineCommit: baseline.baselineCommit,
    usageKeys,
    historyBytes: Buffer.byteLength(history),
    stateFields: 'schema v6; source cache, session/daily projections and fixed scan-state metadata',
    exactColdParity: true,
    crossArmProjectionParity: true,
    serializationParity: true,
    structuredCloneParity: true,
    toolingSha256: sourceHash(await readFile(import.meta.filename)),
    arms
  }
  if (values.output) {
    await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`)
  }
  console.log(JSON.stringify(report))
} finally {
  await rm(home, { recursive: true, force: true })
}
