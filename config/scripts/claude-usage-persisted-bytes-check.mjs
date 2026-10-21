#!/usr/bin/env node
import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { runProcessSync } from '@orca/process-host'
import { loadClaudeUsageBenchmarkScanner } from './claude-usage-benchmark-scanner.mjs'
import {
  claudeBenchmarkSha256,
  claudeBenchmarkState,
  loadClaudeUsageBenchmarkPersistence,
  resolveClaudeBenchmarkCommit,
  serializeClaudeBenchmarkReport
} from './claude-usage-benchmark-persistence.mjs'

const ROOT = join(import.meta.dirname, '../..')
const { values } = parseArgs({ options: { output: { type: 'string' } } })
const refs = {
  original: resolveClaudeBenchmarkCommit('51e7181850b022bae2d41091fe1229accef4bd50'),
  published: resolveClaudeBenchmarkCommit('8467877ed92aba2ef59737aebf461e9cab52c273'),
  main: resolveClaudeBenchmarkCommit('b44a5796c1154de84efa25cc09f3dae2b61eb4b5'),
  current: null
}

function record(cwd, index, usageKeys, unique, correction = false) {
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
        input_tokens: correction ? usageKeys + 2_000 : 100 + (unique ? index : 0),
        output_tokens: 10 + (unique ? index : 0),
        cache_read_input_tokens: unique ? index : 0,
        cache_creation_input_tokens: 20 + (unique ? index : 0),
        cache_creation: { ephemeral_1h_input_tokens: 5 + (unique ? index : 0) }
      }
    }
  })}\n`
}

function readStore(mode, commit) {
  if (!commit) {
    return readFile(join(ROOT, 'src/main/claude-usage/store.ts'), 'utf8')
  }
  const result = runProcessSync({
    program: 'git',
    args: ['show', `${commit}:src/main/claude-usage/store.ts`],
    cwd: ROOT,
    timeoutMs: 10_000,
    maxOutputBytes: 1024 * 1024,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  })
  assert.equal(result.code, 0, `${mode}: ${result.stderr}`)
  return result.stdout
}

function fileComponents(file) {
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value))
  const checkpoint = file.parseResumeState
  return {
    fileBytes: bytes(file),
    ownedKeyListBytes: bytes(file.ownedDedupeKeys),
    tokenColumnsBytes: checkpoint?.ownedTokenColumns ? bytes(checkpoint.ownedTokenColumns) : null,
    tokenRowsBytes: checkpoint?.ownedTokenMaxima ? bytes(checkpoint.ownedTokenMaxima) : null,
    columnValueCounts:
      checkpoint?.ownedTokenColumns?.map((column) => (Array.isArray(column) ? column.length : 1)) ??
      null,
    projectionCount: checkpoint?.projections?.length ?? null
  }
}

const home = await mkdtemp(join(tmpdir(), 'orca-claude-persisted-bytes-'))
try {
  const project = join(home, '.claude', 'projects', 'benchmark')
  const cwd = join(home, 'repo')
  await mkdir(project, { recursive: true })
  await mkdir(cwd)
  const transcriptPath = join(project, 'active-session.jsonl')
  const arms = {}
  for (const mode of Object.keys(refs)) {
    const sources = new Map()
    const scanner = await loadClaudeUsageBenchmarkScanner(home, new Map(), sources, refs[mode])
    const persistence =
      mode === 'original'
        ? null
        : await loadClaudeUsageBenchmarkPersistence(mode, refs[mode], sources)
    const store = await readStore(mode, refs[mode])
    const indent = /jsonIndent:\s*(\d+)/.exec(store)
    arms[mode] = {
      mode,
      scanner,
      persistence,
      indent: indent ? Number(indent[1]) : undefined,
      storeSha256: claudeBenchmarkSha256(store)
    }
  }
  const scenarios = []
  for (const [usageKeys, unique] of [
    [16384, false],
    [100000, true]
  ]) {
    const history = Array.from({ length: usageKeys }, (_, index) =>
      record(cwd, index, usageKeys, unique)
    ).join('')
    const suffix = record(cwd, 7, usageKeys, unique, true)
    let reference
    const measurements = {}
    for (const [name, arm] of Object.entries(arms)) {
      await writeFile(transcriptPath, history)
      const cold = await arm.scanner.scanner.scanClaudeUsageFiles([], [], undefined, [])
      let previous = { sources: cold.processedFiles }
      const sourceRef = {
        path: join(home, `${name}-sources.json`),
        schemaVersion: name === 'current' ? 7 : 6,
        worktreeFingerprint: '[]',
        reuse: true
      }
      if (arm.persistence && name !== 'published') {
        await arm.persistence.module.writeSourceCache(sourceRef, cold.processedFiles)
        const loaded = await arm.persistence.module.readSourceCache(sourceRef)
        previous = name === 'current' ? loaded : { sources: loaded }
      }
      await appendFile(transcriptPath, suffix)
      const result = await arm.scanner.scanner.scanClaudeUsageFiles(
        [],
        previous.sources,
        undefined,
        [],
        previous.verifiedSources
      )
      const fresh = await arm.scanner.scanner.scanClaudeUsageFiles([], [], undefined, [])
      assert.deepEqual(result, fresh)
      const projection = { sessions: result.sessions, dailyAggregates: result.dailyAggregates }
      reference ??= projection
      assert.deepEqual(projection, reference)
      assert.equal(result.processedFiles[0].ownedDedupeKeys.length, usageKeys)
      const state = claudeBenchmarkState(result, name === 'current' ? 7 : 6)
      let reportText
      let sourceText = null
      let savedFile = result.processedFiles[0]
      if (name === 'original' || name === 'published') {
        reportText = JSON.stringify(state, null, arm.indent)
      } else {
        await arm.persistence.module.writeSourceCache(sourceRef, result.processedFiles)
        sourceText = await readFile(sourceRef.path)
        const decoded =
          sourceText[0] === 0x1f && sourceText[1] === 0x8b ? gunzipSync(sourceText) : sourceText
        savedFile = JSON.parse(decoded.toString('utf8')).sources[0]
        reportText = serializeClaudeBenchmarkReport(arm, state)
      }
      measurements[name] = {
        sourceBytes: sourceText ? Buffer.byteLength(sourceText) : 0,
        reportBytes: Buffer.byteLength(reportText),
        totalPersistedBytes:
          (sourceText ? Buffer.byteLength(sourceText) : 0) + Buffer.byteLength(reportText),
        productionIndent: arm.indent ?? null,
        sourceComponents: fileComponents(savedFile)
      }
    }
    scenarios.push({
      usageKeys,
      maximaPattern: unique ? 'unique' : 'repeated',
      historyBytes: Buffer.byteLength(history),
      suffixBytes: Buffer.byteLength(suffix),
      fixtureSha256: claudeBenchmarkSha256(history),
      measurements
    })
  }
  const report = {
    purpose:
      'Four-arm actual production persistence bytes and dominant cache fields; no timing claim.',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    exactColdParity: true,
    crossArmProjectionParity: true,
    methodology:
      'Original/published use their actual store indentation and full-state layout. Fixed main/current use their production source writers and report serializers. Source component lengths exclude enclosing property names and are diagnostic, not additive file sizes.',
    toolingSha256: claudeBenchmarkSha256(await readFile(import.meta.filename)),
    arms: Object.fromEntries(
      Object.entries(arms).map(([name, arm]) => [
        name,
        {
          commit: refs[name],
          storeSha256: arm.storeSha256,
          scanner: {
            bundleSha256: arm.scanner.bundleSha256,
            sourceFingerprints: arm.scanner.sourceFingerprints
          },
          persistence: arm.persistence
            ? {
                bundleSha256: arm.persistence.bundleSha256,
                sourceFingerprints: arm.persistence.sourceFingerprints
              }
            : null
        }
      ])
    ),
    scenarios
  }
  if (values.output) {
    await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`)
  }
  console.log(JSON.stringify(report))
} finally {
  await rm(home, { recursive: true, force: true })
}
