#!/usr/bin/env node
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { loadClaudeUsageBenchmarkScanner } from './claude-usage-benchmark-scanner.mjs'
import {
  claudeBenchmarkSha256,
  claudeBenchmarkState,
  loadClaudeUsageBenchmarkPersistence,
  resolveClaudeBenchmarkCommit,
  serializeClaudeBenchmarkReport
} from './claude-usage-benchmark-persistence.mjs'

const { values } = parseArgs({
  options: {
    'published-ref': { type: 'string', default: '8467877ed92aba2ef59737aebf461e9cab52c273' },
    'main-ref': { type: 'string', default: 'b44a5796c1154de84efa25cc09f3dae2b61eb4b5' },
    'usage-keys': { type: 'string', default: '16384' },
    'maxima-pattern': { type: 'string', default: 'repeated' },
    rounds: { type: 'string', default: '6' },
    output: { type: 'string' }
  }
})
const usageKeys = Number(values['usage-keys'])
const rounds = Number(values.rounds)
const unique = values['maxima-pattern'] === 'unique'
assert(Number.isSafeInteger(usageKeys) && usageKeys > 7)
assert(Number.isSafeInteger(rounds) && rounds > 0 && rounds % 6 === 0)
assert(['repeated', 'unique'].includes(values['maxima-pattern']))

function record(cwd, index, correction = false) {
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

function projection(result) {
  return { sessions: result.sessions, dailyAggregates: result.dailyAggregates }
}

function median(input) {
  const sorted = [...input].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const ORDERS = [
  ['published', 'main', 'current'],
  ['current', 'main', 'published'],
  ['main', 'published', 'current'],
  ['current', 'published', 'main'],
  ['published', 'current', 'main'],
  ['main', 'current', 'published']
]

async function loadArm(home, mode, commit) {
  const sources = new Map()
  const [scanner, persistence] = await Promise.all([
    loadClaudeUsageBenchmarkScanner(home, new Map(), sources, commit),
    loadClaudeUsageBenchmarkPersistence(mode, commit, sources)
  ])
  const cacheFile = join(home, `${mode}-usage.json`)
  const sourceRef = {
    path: join(home, `${mode}-usage-sources.json`),
    schemaVersion: mode === 'current' ? 7 : 6,
    worktreeFingerprint: '[]',
    reuse: true
  }
  const writer = new persistence.module.UsageCacheSnapshotWriter(
    '[persistence-benchmark]',
    () => cacheFile
  )
  await writer.flush()
  return { mode, commit, scanner, persistence, cacheFile, sourceRef, writer, savedSources: [] }
}

async function persist(arm, result, previous) {
  const started = performance.now()
  if (arm.mode === 'current') {
    await arm.persistence.module.persistSourceCache(
      arm.sourceRef,
      result.processedFiles,
      previous ?? { sources: [] }
    )
  } else if (arm.mode !== 'published') {
    await arm.persistence.module.writeSourceCache(arm.sourceRef, result.processedFiles)
  }
  const sourceWrittenAt = performance.now()
  const state = claudeBenchmarkState(result, arm.mode === 'current' ? 7 : 6)
  let reportSerializeMs = 0
  let reportBytes = 0
  await arm.writer.write(() => {
    const serializeStart = performance.now()
    const text = serializeClaudeBenchmarkReport(arm, state)
    reportSerializeMs = performance.now() - serializeStart
    reportBytes = Buffer.byteLength(text)
    return text
  })
  const completedAt = performance.now()
  arm.savedSources = arm.mode === 'published' ? result.processedFiles : []
  const sourceStat =
    arm.mode === 'published' ? null : await stat(arm.sourceRef.path, { bigint: true })
  const sourceBytes = sourceStat ? Number(sourceStat.size) : 0
  const sourceBytesWritten = !sourceStat
    ? 0
    : sourceStat.ino === 0n
      ? null
      : arm.persistedSourceGeneration?.dev === sourceStat.dev &&
          arm.persistedSourceGeneration?.ino === sourceStat.ino
        ? 0
        : sourceBytes
  arm.persistedSourceGeneration = sourceStat
  arm.persistedSourceBytes = sourceBytes
  return {
    sourceWritePackSealDurableMs: sourceWrittenAt - started,
    reportSerializeSealMs: reportSerializeMs,
    reportDurableWriteMs: completedAt - sourceWrittenAt - reportSerializeMs,
    totalPersistMs: completedAt - started,
    sourceBytes,
    sourceBytesWritten,
    reportBytes,
    totalWrittenBytes: sourceBytesWritten === null ? null : sourceBytesWritten + reportBytes,
    totalPersistedBytes: sourceBytes + reportBytes
  }
}

async function refresh(arm, transcriptPath, expected) {
  const sourceBytesRead = arm.persistedSourceBytes
  const readStart = performance.now()
  let previous
  if (arm.mode === 'published') {
    previous = { sources: arm.savedSources }
  } else {
    const loaded = await arm.persistence.module.readSourceCache(arm.sourceRef)
    previous = arm.mode === 'current' ? loaded : { sources: loaded }
  }
  const readAt = performance.now()
  assert.equal(previous.sources.length, 1)
  arm.scanner.scanner.resetReadMetrics()
  const result = await arm.scanner.scanner.scanClaudeUsageFiles(
    [],
    previous.sources,
    undefined,
    [],
    previous.verifiedSources
  )
  const scannedAt = performance.now()
  const transcriptBytesRead = arm.scanner.scanner
    .readMetrics()
    .reduce((sum, read) => sum + read.bytes, 0)
  const persisted = await persist(arm, result, previous)
  assert.deepEqual(projection(result), expected)
  assert.equal(result.processedFiles[0].ownedDedupeKeys.length, usageKeys)
  return {
    sourceReadVerifyDecodeMs: readAt - readStart,
    scanMs: scannedAt - readAt,
    completeRefreshMs: scannedAt - readStart + persisted.totalPersistMs,
    transcriptBytesRead,
    sourceBytesRead,
    totalReadBytes: transcriptBytesRead + sourceBytesRead,
    ...persisted,
    transcriptPath
  }
}

const home = await mkdtemp(join(tmpdir(), 'orca-claude-persistence-cost-'))
try {
  const project = join(home, '.claude', 'projects', 'benchmark')
  const cwd = join(home, 'repo')
  await mkdir(project, { recursive: true })
  await mkdir(cwd)
  const transcriptPath = join(project, 'active-session.jsonl')
  const history = Array.from({ length: usageKeys }, (_, index) => record(cwd, index)).join('')
  const suffix = record(cwd, 7, true)
  const refs = {
    published: resolveClaudeBenchmarkCommit(values['published-ref']),
    main: resolveClaudeBenchmarkCommit(values['main-ref']),
    current: null
  }
  const arms = {}
  for (const mode of Object.keys(refs)) {
    arms[mode] = await loadArm(home, mode, refs[mode])
  }
  const samples = []
  let referenceCold
  let referenceAppend
  for (let round = -1; round < rounds; round += 1) {
    const order = ORDERS[(round + 6) % 6]
    for (const name of order) {
      const arm = arms[name]
      await writeFile(transcriptPath, history)
      arm.scanner.scanner.resetReadMetrics()
      const coldStart = performance.now()
      let cold = await arm.scanner.scanner.scanClaudeUsageFiles([], [], undefined, [])
      const coldAt = performance.now()
      const coldTranscriptBytes = arm.scanner.scanner
        .readMetrics()
        .reduce((sum, read) => sum + read.bytes, 0)
      const coldPersist = await persist(arm, cold)
      referenceCold ??= projection(cold)
      assert.deepEqual(projection(cold), referenceCold)
      cold = null
      const warm = await refresh(arm, transcriptPath, referenceCold)
      await appendFile(transcriptPath, suffix)
      let fresh = await arm.scanner.scanner.scanClaudeUsageFiles([], [], undefined, [])
      referenceAppend ??= projection(fresh)
      assert.deepEqual(projection(fresh), referenceAppend)
      fresh = null
      const appended = await refresh(arm, transcriptPath, referenceAppend)
      if (round >= 0) {
        samples.push({
          arm: name,
          round: round + 1,
          order,
          cold: {
            scanMs: coldAt - coldStart,
            completeRefreshMs: coldAt - coldStart + coldPersist.totalPersistMs,
            transcriptBytesRead: coldTranscriptBytes,
            sourceBytesRead: 0,
            totalReadBytes: coldTranscriptBytes,
            ...coldPersist
          },
          warm,
          append: appended
        })
      }
    }
  }
  const summary = Object.fromEntries(
    Object.keys(arms).map((name) => [
      name,
      Object.fromEntries(
        ['cold', 'warm', 'append'].map((phase) => [
          phase,
          Object.fromEntries(
            Object.entries(samples.find((sample) => sample.arm === name)[phase])
              .filter(([, value]) => typeof value === 'number')
              .map(([metric]) => [
                metric,
                Number(
                  median(
                    samples
                      .filter((sample) => sample.arm === name)
                      .map((sample) => sample[phase][metric])
                  ).toFixed(3)
                )
              ])
          )
        ])
      )
    ])
  )
  const report = {
    purpose: 'Actual pinned Claude scanner, source-cache and durable report persistence costs.',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus()[0]?.model,
    usageKeys,
    maximaPattern: values['maxima-pattern'],
    rounds,
    historyBytes: Buffer.byteLength(history),
    suffixBytes: Buffer.byteLength(suffix),
    fixtureSha256: claudeBenchmarkSha256(history),
    methodology: {
      timing:
        'Six arm permutations balance position/order; one unrecorded warmup. Fixtures are scanner-cache cold and OS-page-cache warm. Durable writes use production fsync/rename writers.',
      refresh:
        'Actual production functions composed in the worker request order: source read/verify/decode, scanner, source pack/seal/durable write, main report serialize/seal/durable write.',
      published:
        'Published B keeps source records in memory; sourceReadBytes=0 reflects that architecture. Its report contains those records.',
      exclusions:
        'Worker startup, message serialization/structured clone, IPC queueing, telemetry, worktree discovery and UI rendering are excluded. Report and source read bytes are logical filesystem payload bytes, not physical device I/O.',
      attribution:
        'Merged-main source/report ownership is inherited; compare current to fixed main to isolate this PR, and published to current for the combined user-visible change.',
      correctness:
        'Exact cold/append cross-arm sessions and daily equality and owned-key count; every append is checked against a fresh scan.',
      writtenBytes:
        'Source writes are logical replacement payload bytes: production durable writers replace the inode when writing. Consecutive bigint file identities prove whether the fixture sidecar was replaced; unavailable inode IDs produce null rather than a zero-write claim. Report payload bytes are captured in the actual writer callback. Accounting stat calls occur outside measured production intervals.'
    },
    toolingSha256: claudeBenchmarkSha256(await readFile(import.meta.filename)),
    supportToolingSha256: claudeBenchmarkSha256(
      await readFile(new URL('./claude-usage-benchmark-persistence.mjs', import.meta.url))
    ),
    arms: Object.fromEntries(
      Object.entries(arms).map(([name, arm]) => [
        name,
        {
          commit: arm.commit,
          scanner: {
            bundleSha256: arm.scanner.bundleSha256,
            sourceFingerprints: arm.scanner.sourceFingerprints
          },
          persistence: {
            bundleSha256: arm.persistence.bundleSha256,
            sourceFingerprints: arm.persistence.sourceFingerprints,
            inactiveLifecycleStubFingerprints: arm.persistence.stubFingerprints
          }
        }
      ])
    ),
    summary,
    samples
  }
  if (values.output) {
    await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`)
  }
  console.log(JSON.stringify(report))
} finally {
  await rm(home, { recursive: true, force: true })
}
