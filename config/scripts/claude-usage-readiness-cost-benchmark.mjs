#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import {
  createClaudeBenchmarkSplitWorker,
  measureClaudeBenchmarkReadiness
} from './claude-usage-benchmark-readiness.mjs'

const { values } = parseArgs({
  options: {
    'published-ref': { type: 'string', default: '8467877ed92aba2ef59737aebf461e9cab52c273' },
    'main-ref': { type: 'string', default: 'b44a5796c1154de84efa25cc09f3dae2b61eb4b5' },
    'usage-keys': { type: 'string', default: '100000' },
    'large-report-mib': { type: 'string', default: '13' },
    rounds: { type: 'string', default: '6' },
    output: { type: 'string' }
  }
})
const usageKeys = Number(values['usage-keys'])
const rounds = Number(values.rounds)
const largeReportBytes = Number(values['large-report-mib']) * 1024 * 1024
assert(Number.isSafeInteger(usageKeys) && usageKeys > 7)
assert(Number.isSafeInteger(rounds) && rounds > 0 && rounds % 6 === 0)
assert(Number.isSafeInteger(largeReportBytes) && largeReportBytes > 8 * 1024 * 1024)

function historyRow(cwd, index) {
  return `${JSON.stringify({
    type: 'assistant',
    sessionId: 'active-session',
    requestId: `request-${index}`,
    timestamp: '2026-10-09T12:00:00.000Z',
    cwd,
    message: {
      id: `message-${index}`,
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 100 + index,
        output_tokens: 10 + index,
        cache_read_input_tokens: index,
        cache_creation_input_tokens: 20 + index,
        cache_creation: { ephemeral_1h_input_tokens: 5 + index }
      }
    }
  })}\n`
}

function largeRollups(result) {
  const session = (index) => ({
    ...result.sessions[0],
    sessionId: `historical-session-${index}`,
    lastCwd: `/historical/project-${index}`,
    locationBreakdown: result.sessions[0].locationBreakdown.map((location) => ({
      ...location,
      locationKey: `project-${index}`,
      projectLabel: `project-${index}`
    }))
  })
  const daily = (index) => ({
    ...result.dailyAggregates[0],
    projectKey: `project-${index}`,
    projectLabel: `project-${index}`
  })
  const unit = JSON.stringify([session(0), daily(0)])
  const count = Math.ceil(largeReportBytes / Buffer.byteLength(unit))
  return {
    processedFiles: [],
    sessions: Array.from({ length: count }, (_, index) => session(index)),
    dailyAggregates: Array.from({ length: count }, (_, index) => daily(index))
  }
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

const home = await mkdtemp(join(tmpdir(), 'orca-claude-readiness-cost-'))
const workers = []
try {
  const project = join(home, '.claude', 'projects', 'benchmark')
  const cwd = join(home, 'repo')
  await mkdir(project, { recursive: true })
  await mkdir(cwd)
  const transcriptPath = join(project, 'active-session.jsonl')
  const history = Array.from({ length: usageKeys }, (_, index) => historyRow(cwd, index)).join('')
  await writeFile(transcriptPath, history)
  const refs = {
    published: resolveClaudeBenchmarkCommit(values['published-ref']),
    main: resolveClaudeBenchmarkCommit(values['main-ref']),
    current: null
  }
  const arms = {}
  for (const mode of Object.keys(refs)) {
    const sources = new Map()
    const scanner = await loadClaudeUsageBenchmarkScanner(home, new Map(), sources, refs[mode])
    const persistence = await loadClaudeUsageBenchmarkPersistence(mode, refs[mode], sources)
    const result = await scanner.scanner.scanClaudeUsageFiles([], [], undefined, [])
    const arm = { mode, commit: refs[mode], scanner, persistence, result }
    arm.stableText = serializeClaudeBenchmarkReport(
      arm,
      claudeBenchmarkState(result, mode === 'current' ? 7 : 6)
    )
    if (mode !== 'published') {
      arm.worker = await createClaudeBenchmarkSplitWorker(arm)
      workers.push(arm.worker)
    }
    arms[mode] = arm
  }
  assert.deepEqual(arms.published.result.sessions, arms.current.result.sessions)
  assert.deepEqual(arms.main.result.sessions, arms.current.result.sessions)
  const inlineText = JSON.stringify(claudeBenchmarkState(arms.published.result))
  const reportResult = largeRollups(arms.current.result)
  const samples = []
  const inputReceipts = {
    legacyInlineBytes: Buffer.byteLength(inlineText),
    legacyInlineSha256: claudeBenchmarkSha256(inlineText),
    stableReportBytes: {},
    largeReportBytes: {},
    largeReportSessions: reportResult.sessions.length
  }
  for (const name of Object.keys(arms)) {
    const arm = arms[name]
    inputReceipts.stableReportBytes[name] = Buffer.byteLength(arm.stableText)
    const state = claudeBenchmarkState(reportResult, name === 'current' ? 7 : 6)
    arm.largeReportText = serializeClaudeBenchmarkReport(arm, state)
    inputReceipts.largeReportBytes[name] = Buffer.byteLength(arm.largeReportText)
    assert(inputReceipts.largeReportBytes[name] >= largeReportBytes)
  }
  async function sample(arm, scenario, text, round, order, options = {}) {
    const cacheFile = join(home, `${arm.mode}-${scenario}.json`)
    await rm(join(home, `${arm.mode}-${scenario}-sources.json`), { force: true })
    await writeFile(cacheFile, text)
    const measured = await measureClaudeBenchmarkReadiness(arm, cacheFile, {
      worker: arm.worker,
      ...options
    })
    assert.equal(measured.state.scanState.enabled, false)
    const expected = scenario.startsWith('large') ? reportResult : arm.result
    assert.deepEqual(measured.state.sessions, expected.sessions)
    assert.deepEqual(measured.state.dailyAggregates, expected.dailyAggregates)
    assert.equal(
      measured.state.processedFiles.length,
      arm.mode === 'published' ? expected.processedFiles.length : 0
    )
    if (round >= 0) {
      samples.push({ arm: arm.mode, scenario, round: round + 1, order, metrics: measured.metrics })
    }
  }
  for (let round = -1; round < rounds; round += 1) {
    const order = ORDERS[(round + 6) % 6]
    for (const name of order) {
      const arm = arms[name]
      await sample(arm, 'stable-cache', arm.stableText, round, order)
      if (name !== 'published') {
        await sample(arm, 'legacy-inline-migration', inlineText, round, order)
      }
    }
    const current = arms.current
    await sample(current, 'legacy-inline-worker-fallback', inlineText, round, ['current'], {
      fallback: true
    })
    const diagnosticOrder = round % 2 ? ['trusted', 'repeat'] : ['repeat', 'trusted']
    for (const variant of diagnosticOrder) {
      await sample(
        current,
        `large-report-${variant}-verification`,
        current.largeReportText,
        round,
        diagnosticOrder,
        { repeatMainVerification: variant === 'repeat' }
      )
    }
    await sample(arms.main, 'large-report-upstream', arms.main.largeReportText, round, ['main'])
    await sample(
      current,
      'large-report-worker-fallback',
      current.largeReportText,
      round,
      ['current'],
      { fallback: true }
    )
  }
  const serializeSamples = []
  for (let round = 0; round < rounds; round += 1) {
    for (const name of round % 2 ? ['current', 'main'] : ['main', 'current']) {
      const started = performance.now()
      const text = serializeClaudeBenchmarkReport(
        arms[name],
        claudeBenchmarkState(reportResult, name === 'current' ? 7 : 6)
      )
      const ms = performance.now() - started
      assert.equal(text, arms[name].largeReportText)
      serializeSamples.push({ arm: name, round: round + 1, serializeSealMs: ms })
    }
  }
  const groups = new Map()
  for (const sample of samples) {
    const key = `${sample.arm}:${sample.scenario}`
    if (!groups.has(key)) {
      groups.set(key, [])
    }
    groups.get(key).push(sample)
  }
  const summary = Object.fromEntries(
    [...groups].map(([key, raw]) => [
      key,
      Object.fromEntries(
        Object.keys(raw[0].metrics)
          .filter((metric) => typeof raw[0].metrics[metric] === 'number')
          .map((metric) => [
            metric,
            Number(median(raw.map((sample) => sample.metrics[metric])).toFixed(3))
          ])
      )
    ])
  )
  const report = {
    purpose:
      'Actual store lifecycle readiness, worker migration/fallback and large aggregate-report costs.',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus()[0]?.model,
    rounds,
    usageKeys,
    inputReceipts,
    methodology: {
      actual:
        'Production lifecycle, report parser/serializer, inline migration and source durable writes. Prestarted Node workers call the actual splitter and return exact immutable reportText/proof fact.',
      segments:
        'Constructor interval includes synchronous stat/read/parse. Main JSON.parse calls and production setImmediate validation yields are observed without changing their inputs/results. Segment observations exclude time waiting for the worker/filesystem.',
      shortcut:
        'Large-report repeat arm deliberately re-verifies the same worker-validated text on main; trusted arm uses the private worker result fact. Both preserve exact report and disabled-history accessibility.',
      largeReport:
        'About 13MiB of distinct aggregate rollups, with no source graph. This isolates a retained valid report even when its independently committed source cache is absent; it does not claim transcript parity for a generated historical corpus.',
      exclusions:
        'Worker startup, application startup, rendered responsiveness, RPC queueing and telemetry are excluded. Inactive telemetry/analytics/worktree accesses throw if reached. Worker message transfer and production main parse remain included in whenLoaded.',
      correctness:
        'Each loaded sessions/daily projection matches its input, remains accessible with tracking disabled, and report-only stores retain no source graph.'
    },
    toolingSha256: claudeBenchmarkSha256(await readFile(import.meta.filename)),
    supportToolingSha256: Object.fromEntries(
      await Promise.all(
        [
          'claude-usage-benchmark-persistence.mjs',
          'claude-usage-benchmark-readiness.mjs',
          'claude-usage-benchmark-scanner.mjs'
        ].map(async (path) => [
          path,
          claudeBenchmarkSha256(await readFile(new URL(path, import.meta.url)))
        ])
      )
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
          },
          workerBootstrapSha256: arm.worker
            ? claudeBenchmarkSha256(arm.worker.bootstrapSha256Input)
            : null
        }
      ])
    ),
    summary,
    samples,
    largeReportSerializeSamples: serializeSamples
  }
  if (values.output) {
    await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`)
  }
  console.log(JSON.stringify(report))
} finally {
  await Promise.all(workers.map((worker) => worker.close()))
  await rm(home, { recursive: true, force: true })
}
