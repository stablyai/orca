#!/usr/bin/env node
// --compare counterbalances HEAD/current; --verify checks current byte/state budgets.
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { cpus, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import {
  describeClaudeUsageBenchmarkTooling,
  loadClaudeUsageBenchmarkScanner,
  measureClaudeUsageBenchmarkScan as measure,
  readClaudeUsageBenchmarkBaselineSources,
  verifyClaudeUsageBenchmarkReadAccounting
} from './claude-usage-benchmark-scanner.mjs'

const ROUNDS = Number(process.env.ORCA_CLAUDE_USAGE_APPEND_BENCH_ROUNDS ?? '8')
assert(Number.isSafeInteger(ROUNDS) && ROUNDS > 0, 'benchmark rounds must be a positive integer')
const VERIFY = process.argv.includes('--verify')
const BASELINE = process.argv.includes('--baseline')
const COMPARE = process.argv.includes('--compare')
assert(!(VERIFY && BASELINE), '--verify and --baseline cannot be combined')
assert(!(COMPARE && BASELINE), '--compare and --baseline cannot be combined')
assert(!COMPARE || ROUNDS % 2 === 0, '--compare requires an even round count')
const TURN_COUNT = 256
const NEW_TURN_COUNT = 8
const MIB = 1024 * 1024

function usageRecord(cwd, index, inputTokens = 100, cacheReadTokens = 0) {
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
        cache_read_input_tokens: cacheReadTokens,
        cache_creation_input_tokens: 20,
        cache_creation: { ephemeral_1h_input_tokens: 5 }
      }
    }
  })}\n`
}

function userRecord(content) {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content }] }
  })}\n`
}

function createHistory(cwd, toolMiB, turnCount) {
  const piece = '工具結果 🌊 benchmark tool output\n'
  const tool = userRecord(piece.repeat(Math.ceil((2 * MIB) / Buffer.byteLength(piece))))
  const rows = Array.from({ length: toolMiB / 2 }, () => tool)
  for (let index = 0; index < turnCount; index++) {
    rows.push(usageRecord(cwd, index))
    if (index % 7 === 0) {
      rows.push(usageRecord(cwd, index, 150))
    }
  }
  return { content: rows.join(''), lineCount: rows.length }
}

function createAppend(cwd, turnCount) {
  const rows = [userRecord('新しい入力 🐳'), usageRecord(cwd, 7, 2_000, 60)]
  for (let index = turnCount; index < turnCount + NEW_TURN_COUNT; index++) {
    rows.push(usageRecord(cwd, index))
  }
  rows.push(usageRecord(cwd, turnCount, 225, 40))
  return { content: rows.join(''), lineCount: rows.length }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function summarize(samples) {
  return Object.fromEntries(
    Object.keys(samples[0]).map((key) => [
      key,
      Number(median(samples.map((sample) => sample[key])).toFixed(3))
    ])
  )
}

function measurementSchedule(arms) {
  const names = Object.keys(arms)
  return names.length === 2
    ? buildCounterbalancedSchedule(ROUNDS, names[0], names[1])
    : Array.from({ length: ROUNDS }, () => names)
}

function behaviorSnapshot(result) {
  return {
    sessions: result.sessions,
    dailyAggregates: result.dailyAggregates,
    processedFiles: result.processedFiles.map((file) => ({
      path: file.path,
      size: file.size,
      lineCount: file.lineCount,
      sessions: file.sessions,
      dailyAggregates: file.dailyAggregates,
      ownedDedupeKeys: file.ownedDedupeKeys,
      hasDeferredClaims: file.hasDeferredClaims
    }))
  }
}

function recordRound(samples, measurements, arm, round, order, reference) {
  const behavior = Object.fromEntries(
    Object.entries(measurements).map(([phase, measurement]) => [
      phase,
      behaviorSnapshot(measurement.result)
    ])
  )
  if (reference) {
    assert.deepEqual(behavior, reference, `cross-arm behavior differs in round ${round + 1}`)
  }
  samples.push({
    arm,
    round: round + 1,
    order,
    phases: Object.fromEntries(
      Object.entries(measurements).map(([phase, measurement]) => [phase, measurement.metrics])
    )
  })
  return behavior
}

function finishSamples(samples) {
  return Object.fromEntries(
    [...new Set(samples.map((sample) => sample.arm))].map((arm) => {
      const rawSamples = samples.filter((sample) => sample.arm === arm)
      return [
        arm,
        {
          phases: Object.fromEntries(
            Object.keys(rawSamples[0].phases).map((phase) => [
              phase,
              summarize(rawSamples.map((sample) => sample.phases[phase]))
            ])
          ),
          rawSamples
        }
      ]
    })
  )
}

async function runScenario(arms, transcriptPath, cwd, toolMiB, turnCount = TURN_COUNT) {
  const history = createHistory(cwd, toolMiB, turnCount)
  const append = createAppend(cwd, turnCount)
  const historyBytes = Buffer.byteLength(history.content)
  const appendBytes = Buffer.byteLength(append.content)
  const samples = []
  for (const [round, order] of measurementSchedule(arms).entries()) {
    let reference = null
    for (const arm of order) {
      const scanner = arms[arm].scanner
      await writeFile(transcriptPath, history.content)
      const cold = await measure(scanner, transcriptPath)
      const warm = await measure(scanner, transcriptPath, cold.cache)
      assert.deepEqual(warm.result, cold.result, 'warm scan differs from a fresh scan')
      assert.equal(cold.result.sessions[0]?.turnCount, turnCount)
      assert.equal(cold.result.processedFiles[0]?.lineCount, history.lineCount)
      assert(cold.metrics.bytesRead >= historyBytes, 'cold scan skipped transcript bytes')
      assert.equal(warm.metrics.bytesRead, 0, 'unchanged scan reread transcript bytes')

      await appendFile(transcriptPath, append.content)
      const appended = await measure(scanner, transcriptPath, warm.cache)
      const fresh = await measure(scanner, transcriptPath)
      assert.deepEqual(appended.result, fresh.result, 'append scan differs from a fresh scan')
      assert.equal(appended.result.sessions[0]?.turnCount, turnCount + NEW_TURN_COUNT)
      assert.equal(
        appended.result.sessions[0]?.totalInputTokens,
        turnCount * 100 + Math.ceil(turnCount / 7) * 50 + 1_850 + NEW_TURN_COUNT * 100 + 125
      )
      assert.equal(appended.result.sessions[0]?.totalCacheReadTokens, 100)
      assert.equal(
        appended.result.dailyAggregates.reduce(
          (sum, daily) => sum + daily.zeroCacheReadTurnCount,
          0
        ),
        turnCount + NEW_TURN_COUNT - 2
      )
      assert.equal(
        appended.result.processedFiles[0]?.lineCount,
        history.lineCount + append.lineCount
      )
      if (VERIFY && arm === 'current') {
        assert(
          appended.metrics.bytesRead <= appendBytes + 64 * 1024,
          'append reread transcript history'
        )
      }
      reference = recordRound(
        samples,
        { cold, warm, append: appended, freshAfterAppend: fresh },
        arm,
        round,
        order,
        reference
      )
    }
  }
  return { toolMiB, usageKeys: turnCount, historyBytes, appendBytes, arms: finishSamples(samples) }
}

async function runSmallCorpus(arms, project, cwd) {
  const directory = join(project, 'small-transcripts')
  await mkdir(directory)
  const files = Array.from({ length: 1_000 }, (_, index) => ({
    path: join(directory, `${String(index).padStart(4, '0')}.jsonl`),
    prefix: usageRecord(cwd, index),
    append: usageRecord(cwd, index, 200, 30)
  }))
  const paths = files.map((file) => file.path)
  const historyBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.prefix), 0)
  const appendBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.append), 0)
  const samples = []
  try {
    for (const [round, order] of measurementSchedule(arms).entries()) {
      let reference = null
      for (const arm of order) {
        const scanner = arms[arm].scanner
        for (let start = 0; start < files.length; start += 64) {
          await Promise.all(
            files.slice(start, start + 64).map((file) => writeFile(file.path, file.prefix))
          )
        }
        const cold = await measure(scanner, paths)
        const warm = await measure(scanner, paths, cold.cache)
        assert.deepEqual(warm.result, cold.result)
        assert.equal(cold.result.sessions[0]?.turnCount, files.length)
        assert.equal(warm.metrics.bytesRead, 0)
        for (let start = 0; start < files.length; start += 64) {
          await Promise.all(
            files.slice(start, start + 64).map((file) => appendFile(file.path, file.append))
          )
        }
        const changed = await measure(scanner, paths, warm.cache)
        const fresh = await measure(scanner, paths)
        assert.deepEqual(changed.result, fresh.result)
        assert.equal(changed.result.sessions[0]?.turnCount, files.length)
        assert.equal(changed.result.sessions[0]?.totalInputTokens, files.length * 200)
        if (VERIFY && arm === 'current') {
          // A small snapshot needs its parse and one content recheck.
          assert(
            cold.metrics.bytesRead <= historyBytes * 2,
            'tiny cold files paid repeated checkpoint overhead'
          )
          assert(
            changed.metrics.bytesRead <= (historyBytes + appendBytes) * 2,
            'tiny changed files paid repeated checkpoint overhead'
          )
        }
        reference = recordRound(
          samples,
          { cold, warm, changed, freshAfterChange: fresh },
          arm,
          round,
          order,
          reference
        )
      }
    }
    return {
      scenario: 'small-transcript-corpus',
      files: files.length,
      historyBytes,
      appendBytes,
      arms: finishSamples(samples)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const home = await mkdtemp(join(tmpdir(), 'orca-claude-usage-append-benchmark-'))
try {
  const project = join(home, '.claude', 'projects', 'benchmark')
  const cwd = join(home, 'repo')
  await mkdir(project, { recursive: true })
  await mkdir(cwd)
  const transcriptPath = join(project, 'active-session.jsonl')
  const baseline = BASELINE || COMPARE ? await readClaudeUsageBenchmarkBaselineSources() : null
  const names = BASELINE ? ['baseline'] : COMPARE ? ['baseline', 'current'] : ['current']
  const worktreeSources = new Map()
  const arms = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        await loadClaudeUsageBenchmarkScanner(
          home,
          name === 'baseline' ? baseline.sources : new Map(),
          worktreeSources,
          name === 'baseline' ? baseline.baselineCommit : null
        )
      ])
    )
  )
  for (const { scanner } of Object.values(arms)) {
    await verifyClaudeUsageBenchmarkReadAccounting(scanner, transcriptPath)
  }
  await rm(transcriptPath)
  const processors = cpus()
  console.log(
    JSON.stringify({
      node: process.version,
      nodeFlags: process.execArgv,
      platform: process.platform,
      osRelease: release(),
      arch: process.arch,
      cpuModel: processors[0]?.model,
      cpuCount: processors.length,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      rounds: ROUNDS,
      verify: VERIFY,
      mode: COMPARE ? 'compare' : names[0],
      baselineRef: baseline?.baselineRef ?? null,
      baselineCommit: baseline?.baselineCommit ?? null,
      tooling: await describeClaudeUsageBenchmarkTooling(),
      bundleSha256: Object.fromEntries(
        Object.entries(arms).map(([name, arm]) => [name, arm.bundleSha256])
      ),
      sourceFingerprints: Object.fromEntries(
        Object.entries(arms).map(([name, arm]) => [name, arm.sourceFingerprints])
      ),
      measurement: {
        cold: 'scanner-cache cold; fixtures freshly written and page-cache warm',
        durationMs: 'production scan only; excludes fixture I/O and cache serialization',
        totalDurationMs: 'production scan plus cache stringify; excludes JSON.parse hydration',
        bytesRead: 'raw filesystem API bytes including checkpoint windows; excludes metadata calls',
        behaviorParity:
          'exact legacy per-file and aggregate projections; excludes mtime and additive cache metadata'
      }
    })
  )
  console.log(JSON.stringify(await runSmallCorpus(arms, project, cwd)))
  const results = []
  for (const toolMiB of [2, 32]) {
    const result = await runScenario(arms, transcriptPath, cwd, toolMiB)
    results.push(result)
    console.log(JSON.stringify({ scenario: 'history-scaling', ...result }))
  }
  const [small, large] = results
  const scaling = Object.fromEntries(
    names.map((arm) => [
      arm,
      {
        historyByteRatio: large.historyBytes / small.historyBytes,
        appendReadByteRatio:
          large.arms[arm].phases.append.bytesRead / small.arms[arm].phases.append.bytesRead,
        appendDurationRatio:
          large.arms[arm].phases.append.durationMs / small.arms[arm].phases.append.durationMs,
        cachedStateByteRatio:
          large.arms[arm].phases.append.cachedStateBytes /
          small.arms[arm].phases.append.cachedStateBytes
      }
    ])
  )
  console.log(JSON.stringify({ scaling, exactColdParity: true, crossArmBehaviorParity: COMPARE }))
  if (VERIFY) {
    assert(
      scaling.current.appendReadByteRatio <= 1.1,
      'append reads scale with raw transcript history'
    )
    assert(
      large.arms.current.phases.append.cachedStateBytes <=
        small.arms.current.phases.append.cachedStateBytes + 512,
      'cache retained raw tool history'
    )
  }
  const keyResults = [large]
  for (const usageKeys of [4_096, 16_384]) {
    const result = await runScenario(arms, transcriptPath, cwd, 32, usageKeys)
    keyResults.push(result)
    console.log(JSON.stringify({ scenario: 'usage-key-scaling', ...result }))
  }
  console.log(
    JSON.stringify({
      keyScaling: keyResults.map((result) => ({
        usageKeys: result.usageKeys,
        historyBytes: result.historyBytes,
        arms: Object.fromEntries(names.map((arm) => [arm, result.arms[arm].phases.append]))
      }))
    })
  )
} finally {
  await rm(home, { recursive: true, force: true })
}
