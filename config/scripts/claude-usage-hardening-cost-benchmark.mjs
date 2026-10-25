#!/usr/bin/env node
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { cpus, tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { runProcessSync } from '@orca/process-host'
import {
  loadClaudeUsageBenchmarkScanner,
  readClaudeUsageBenchmarkBaselineSources
} from './claude-usage-benchmark-scanner.mjs'

const ROOT = join(import.meta.dirname, '../..')
const { values } = parseArgs({
  options: {
    'baseline-ref': { type: 'string', default: '51e7181850b022bae2d41091fe1229accef4bd50' },
    'usage-keys': { type: 'string', default: '16384' },
    rounds: { type: 'string', default: '8' },
    output: { type: 'string' }
  }
})
const usageKeys = Number(values['usage-keys'])
const rounds = Number(values.rounds)
assert(Number.isSafeInteger(usageKeys) && usageKeys > 7)
assert(Number.isSafeInteger(rounds) && rounds > 0 && rounds % 2 === 0)
process.env.ORCA_CLAUDE_USAGE_APPEND_BENCH_BASELINE = values['baseline-ref']

function sha256(source) {
  return createHash('sha256').update(source).digest('hex')
}

function productionIndent(source) {
  const match = /jsonIndent:\s*(\d+)/.exec(source)
  return match ? Number(match[1]) : undefined
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

function usageRecord(cwd, index, maximaPattern, correction = false) {
  const unique = maximaPattern === 'unique-maxima'
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
        input_tokens: correction ? 2_000 : 100 + (unique ? index : 0),
        output_tokens: 10 + (unique ? index : 0),
        cache_read_input_tokens: unique ? index : 0,
        cache_creation_input_tokens: 20 + (unique ? index : 0),
        cache_creation: { ephemeral_1h_input_tokens: 5 + (unique ? index : 0) }
      }
    }
  })}\n`
}

async function loadValidation(frozenSources) {
  const fingerprints = {}
  const bundled = await build({
    stdin: {
      contents: `export { validatePersistedClaudeUsageProjections } from './src/main/claude-usage/persisted-projection-validation';
        export { buildClaudeUsageProjectionIntegrity } from './src/main/claude-usage/transcript-projection-integrity';
        export { hasClaudeUsageResumeProjection } from './src/main/claude-usage/transcript-resume-projection';`,
      loader: 'ts',
      resolveDir: ROOT
    },
    platform: 'node',
    format: 'esm',
    bundle: true,
    write: false,
    plugins: [
      {
        name: 'frozen-validation-source',
        setup(bundler) {
          bundler.onLoad({ filter: /[/\\]src[/\\].*\.ts$/ }, async ({ path }) => {
            if (!frozenSources.has(path)) {
              frozenSources.set(path, readFile(path, 'utf8'))
            }
            const contents = await frozenSources.get(path)
            fingerprints[relative(ROOT, path).split(sep).join('/')] = sha256(contents)
            return { contents, loader: 'ts', resolveDir: dirname(path) }
          })
        }
      }
    ]
  })
  const code = bundled.outputFiles[0].text
  return {
    module: await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`),
    bundleSha256: sha256(code),
    sourceFingerprints: fingerprints
  }
}

function measureSerialization(result, indent, validation) {
  const state = persistedState(result)
  const start = performance.now()
  const serialized = JSON.stringify(state, null, indent)
  const serializedAt = performance.now()
  const parsed = JSON.parse(serialized)
  const parsedAt = performance.now()
  const loaded = validation ? validation.validatePersistedClaudeUsageProjections(parsed) : parsed
  const validatedAt = performance.now()
  assert.deepEqual(loaded.sessions, result.sessions)
  assert.deepEqual(loaded.dailyAggregates, result.dailyAggregates)
  return {
    cache: parsed.processedFiles,
    metrics: {
      productionStateBytes: Buffer.byteLength(serialized),
      serializeMs: serializedAt - start,
      parseMs: parsedAt - serializedAt,
      loadValidationMs: validatedAt - parsedAt,
      totalLoadMs: validatedAt - serializedAt
    }
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length / 2
  return (sorted[middle - 1] + sorted[middle]) / 2
}

const home = await mkdtemp(join(tmpdir(), 'orca-claude-hardening-cost-'))
try {
  const project = join(home, '.claude', 'projects', 'benchmark')
  const cwd = join(home, 'repo')
  await mkdir(project, { recursive: true })
  await mkdir(cwd)
  const transcriptPath = join(project, 'active-session.jsonl')
  const baseline = await readClaudeUsageBenchmarkBaselineSources()
  const storeRead = runProcessSync({
    program: 'git',
    args: ['show', `${baseline.baselineCommit}:src/main/claude-usage/store.ts`],
    cwd: ROOT,
    timeoutMs: 10_000,
    maxOutputBytes: 1024 * 1024,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  })
  assert.equal(storeRead.code, 0, storeRead.stderr)
  const currentStore = await readFile(join(ROOT, 'src/main/claude-usage/store.ts'), 'utf8')
  const frozenSources = new Map()
  const [oldScanner, currentScanner] = await Promise.all([
    loadClaudeUsageBenchmarkScanner(home, baseline.sources, new Map(), baseline.baselineCommit),
    loadClaudeUsageBenchmarkScanner(home, new Map(), frozenSources)
  ])
  const validation = await loadValidation(frozenSources)
  const arms = {
    baseline: { ...oldScanner, indent: productionIndent(storeRead.stdout) },
    current: { ...currentScanner, indent: productionIndent(currentStore) }
  }
  const scenarios = []
  for (const maximaPattern of ['repeated-maxima', 'unique-maxima']) {
    const history = Array.from({ length: usageKeys }, (_, index) =>
      usageRecord(cwd, index, maximaPattern)
    ).join('')
    const suffix = usageRecord(cwd, 7, maximaPattern, true)
    const samples = []
    for (const arm of Object.values(arms)) {
      await writeFile(transcriptPath, history)
      const warmup = await arm.scanner.scanClaudeUsageFiles([], [], undefined, [])
      measureSerialization(warmup, arm.indent, arm === arms.current ? validation.module : null)
    }
    for (const [round, order] of buildCounterbalancedSchedule(
      rounds,
      'baseline',
      'current'
    ).entries()) {
      let reference
      for (const name of order) {
        const arm = arms[name]
        const check = name === 'current' ? validation.module : null
        await writeFile(transcriptPath, history)
        const started = performance.now()
        const cold = await arm.scanner.scanClaudeUsageFiles([], [], undefined, [])
        const coldAt = performance.now()
        const coldState = measureSerialization(cold, arm.indent, check)
        await appendFile(transcriptPath, suffix)
        arm.scanner.resetReadMetrics()
        const appendStart = performance.now()
        const appended = await arm.scanner.scanClaudeUsageFiles([], coldState.cache, undefined, [])
        const appendAt = performance.now()
        const appendBytesRead = arm.scanner.readMetrics().reduce((sum, read) => sum + read.bytes, 0)
        const appendedState = measureSerialization(appended, arm.indent, check)
        const fresh = await arm.scanner.scanClaudeUsageFiles([], [], undefined, [])
        assert.deepEqual(appended, fresh)
        const projection = {
          sessions: appended.sessions,
          dailyAggregates: appended.dailyAggregates
        }
        if (reference) {
          assert.deepEqual(projection, reference)
        }
        reference = projection
        let integrityBuildMs = 0
        let integrityValidateMs = 0
        if (check) {
          const file = appended.processedFiles[0]
          const buildStart = performance.now()
          const integrity = check.buildClaudeUsageProjectionIntegrity(file)
          const builtAt = performance.now()
          const valid = check.hasClaudeUsageResumeProjection(file)
          const validatedAt = performance.now()
          assert.equal(integrity, file.parseResumeState.projectionIntegrity)
          assert.equal(valid, true)
          integrityBuildMs = builtAt - buildStart
          integrityValidateMs = validatedAt - builtAt
        }
        samples.push({
          arm: name,
          round: round + 1,
          order,
          metrics: {
            coldScanMs: coldAt - started,
            coldTotalLoadMs: coldState.metrics.totalLoadMs,
            appendScanMs: appendAt - appendStart,
            appendScanAndPersistSerializationMs:
              appendAt - appendStart + appendedState.metrics.serializeMs,
            appendBytesRead,
            ...appendedState.metrics,
            integrityBuildMs,
            integrityValidateMs
          }
        })
      }
    }
    scenarios.push({
      maximaPattern,
      usageKeys,
      historyBytes: Buffer.byteLength(history),
      appendBytes: Buffer.byteLength(suffix),
      arms: Object.fromEntries(
        Object.keys(arms).map((name) => {
          const rawSamples = samples.filter((sample) => sample.arm === name)
          return [
            name,
            {
              medians: Object.fromEntries(
                Object.keys(rawSamples[0].metrics).map((metric) => [
                  metric,
                  Number(median(rawSamples.map((sample) => sample.metrics[metric])).toFixed(3))
                ])
              ),
              rawSamples
            }
          ]
        })
      )
    })
  }
  const report = {
    purpose:
      'Counterbalanced actual scanner and synchronous production cache-load costs after hardening.',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus()[0]?.model,
    rounds,
    baselineCommit: baseline.baselineCommit,
    methodology: {
      fixture:
        'Fresh temporary transcripts with page-cache-warm I/O; source-cache cold before each round.',
      timing:
        'Scanner timings include checkpoint build/verify. Serialization follows actual store indent. Load includes JSON.parse and current on-load integrity validation; fs cache read/durable write are excluded.',
      integrityTiming:
        'Separate actual checksum build and full checkpoint validation calls after parity checks; these are diagnostic components, not additional production scan cost.',
      correctness:
        'Exact append/fresh parity each arm, cross-arm sessions/daily equality, and loaded aggregate equality.'
    },
    toolingSha256: sha256(await readFile(import.meta.filename)),
    storeSha256: { baseline: sha256(storeRead.stdout), current: sha256(currentStore) },
    scannerSources: Object.fromEntries(
      Object.entries(arms).map(([name, arm]) => [
        name,
        {
          bundleSha256: arm.bundleSha256,
          sourceFingerprints: arm.sourceFingerprints
        }
      ])
    ),
    validationSources: {
      bundleSha256: validation.bundleSha256,
      sourceFingerprints: validation.sourceFingerprints
    },
    scenarios
  }
  if (values.output) {
    await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`)
  }
  console.log(JSON.stringify(report))
} finally {
  await rm(home, { recursive: true, force: true })
}
