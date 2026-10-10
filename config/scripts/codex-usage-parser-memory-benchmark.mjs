import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, cpus, release, tmpdir, totalmem } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
const digest = (value) => createHash('sha256').update(value).digest('hex')
const args = process.argv.slice(2)

function argument(name, fallback) {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}

function positiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return parsed
}

function memorySnapshot(phase, started) {
  globalThis.gc()
  globalThis.gc()
  return { phase, elapsedMs: performance.now() - started, ...process.memoryUsage() }
}

async function runWorker() {
  assert.equal(typeof globalThis.gc, 'function', 'Run workers with --expose-gc')
  const parser = await import(pathToFileURL(argument('--bundle')).href)
  const count = positiveInteger(argument('--events'), 'events')
  const stride = positiveInteger(argument('--stride'), 'stride')
  const intervalMs = positiveInteger(argument('--sample-ms'), 'sample-ms')
  const arm = argument('--arm')
  let claimQueries = 0
  let committedKeys = 0
  const canClaim = () => claimQueries++ % stride === 0
  const options =
    arm === 'baseline'
      ? { claimEventKey: canClaim }
      : { canClaimEventKey: canClaim, commitEventKey: () => committedKeys++ }
  const started = performance.now()
  const baseline = memorySnapshot('before', started)
  const samples = []
  const timer = setInterval(() => samples.push(memorySnapshot('during', started)), intervalMs)
  let result
  try {
    result = await parser.parseCodexUsageFile(argument('--fixture'), () => null, options)
  } finally {
    clearInterval(timer)
  }
  globalThis.__orcaMemoryResult = result
  const final = memorySnapshot('after', started)
  const duringSampleCount = samples.length
  samples.push(final)
  const expected = Math.ceil(count / stride)
  const correctness = {
    claimQueries,
    committedKeys: arm === 'baseline' ? null : committedKeys,
    ownedKeys: result.ownedEventKeys.length,
    countedEvents: result.sessions.reduce((sum, session) => sum + session.eventCount, 0),
    inputTokens: result.sessions.reduce((sum, session) => sum + session.totalInputTokens, 0),
    outputTokens: result.sessions.reduce((sum, session) => sum + session.totalOutputTokens, 0),
    totalTokens: result.sessions.reduce((sum, session) => sum + session.totalTokens, 0),
    hasDeferredClaims: result.hasDeferredClaims,
    projectionSha256: digest(
      JSON.stringify({
        sessions: result.sessions,
        dailyAggregates: result.dailyAggregates,
        ownedEventKeys: result.ownedEventKeys,
        hasDeferredClaims: result.hasDeferredClaims
      })
    )
  }
  assert.equal(correctness.claimQueries, count)
  assert.equal(correctness.ownedKeys, expected)
  assert.equal(correctness.countedEvents, expected)
  assert.equal(correctness.inputTokens, expected * 100)
  assert.equal(correctness.outputTokens, expected * 10)
  assert.equal(correctness.totalTokens, expected * 110)
  assert.equal(correctness.hasDeferredClaims, stride > 1 && count > 1)
  if (arm === 'current') {
    assert.equal(committedKeys, expected)
  }
  process.stdout.write(
    `${JSON.stringify({
      arm,
      stride,
      duringSampleCount,
      finalOnlyMeasurement: duringSampleCount === 0,
      baseline,
      samples,
      sampledRetainedPeakDeltaBytes:
        Math.max(...samples.map((sample) => sample.heapUsed)) - baseline.heapUsed,
      finalRetainedDeltaBytes: final.heapUsed - baseline.heapUsed,
      correctness
    })}\n`
  )
  delete globalThis.__orcaMemoryResult
}

function writeFixture(filePath, eventCount) {
  const cwd = join('benchmark', 'workspace')
  writeFileSync(
    filePath,
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'session', cwd } })}\n`
  )
  let batch = ''
  for (let index = 0; index < eventCount; index++) {
    batch += `${JSON.stringify({
      timestamp: new Date(1791547200000 + index * 1000).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model: 'gpt-5-codex',
          last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
        }
      }
    })}\n`
    if ((index + 1) % 5000 === 0) {
      appendFileSync(filePath, batch)
      batch = ''
    }
  }
  if (batch) {
    appendFileSync(filePath, batch)
  }
}

async function runComparison() {
  const { build, version: esbuildVersion } = await import('esbuild')
  const { runProcessSync, describeProcessFailure } = await import('./script-child-process.mjs')
  const { buildCounterbalancedSchedule } = await import('./counterbalanced-benchmark-schedule.mjs')
  const eventCount = positiveInteger(argument('--events', '100000'), 'events')
  const pairCount = positiveInteger(argument('--pairs', '2'), 'pairs')
  const intervalMs = positiveInteger(argument('--sample-ms', '35'), 'sample-ms')
  const schedule = buildCounterbalancedSchedule(pairCount, 'baseline', 'current')
  const execute = (program, commandArgs) => {
    const result = runProcessSync({
      program,
      args: commandArgs,
      cwd: root,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 120000,
      maxOutputBytes: 16 * 1024 * 1024
    })
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error(describeProcessFailure(result))
    }
    return result.stdout
  }
  const baselineCommit = execute('git', [
    'rev-parse',
    '--verify',
    `${argument('--baseline-ref', 'HEAD')}^{commit}`
  ]).trim()
  const temporary = mkdtempSync(join(tmpdir(), 'orca-codex-parser-memory-'))
  try {
    const sources = {}
    const bundles = {}
    for (const arm of ['baseline', 'current']) {
      const sourceHashes = new Map()
      const bundlePath = join(temporary, `${arm}.mjs`)
      await build({
        entryPoints: [join(root, 'src/main/codex-usage/codex-rollout-file-parse.ts')],
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'esm',
        outfile: bundlePath,
        logLevel: 'silent',
        plugins: [
          {
            name: 'record-parser-source-graph',
            setup(builder) {
              builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, ({ path }) => {
                const sourcePath = relative(root, path).split(sep).join('/')
                if (!sourcePath.startsWith('src/')) {
                  return undefined
                }
                const contents =
                  arm === 'baseline'
                    ? execute('git', ['show', `${baselineCommit}:${sourcePath}`])
                    : readFileSync(path, 'utf8')
                sourceHashes.set(sourcePath, digest(contents))
                return {
                  contents,
                  resolveDir: dirname(path),
                  loader: sourcePath.endsWith('.tsx') ? 'tsx' : 'ts'
                }
              })
            }
          }
        ]
      })
      bundles[arm] = bundlePath
      sources[arm] = {
        origin: arm === 'baseline' ? baselineCommit : 'worktree at bundle build',
        files: Object.fromEntries(
          [...sourceHashes].sort(([left], [right]) => left.localeCompare(right))
        ),
        bundleSha256: digest(readFileSync(bundlePath))
      }
    }
    const fixturePath = join(temporary, 'rollout.jsonl')
    writeFixture(fixturePath, eventCount)
    const fixtureBytes = readFileSync(fixturePath)
    const measurements = []
    for (let round = 0; round < schedule.length; round++) {
      for (const stride of [1, 10]) {
        const paired = []
        for (const arm of schedule[round]) {
          const measurement = JSON.parse(
            execute(process.execPath, [
              '--expose-gc',
              import.meta.filename,
              '--worker',
              '--bundle',
              bundles[arm],
              '--fixture',
              fixturePath,
              '--events',
              String(eventCount),
              '--stride',
              String(stride),
              '--sample-ms',
              String(intervalMs),
              '--arm',
              arm
            ])
          )
          paired.push(measurement)
          measurements.push({ round: round + 1, order: schedule[round], ...measurement })
        }
        assert.equal(paired[0].correctness.projectionSha256, paired[1].correctness.projectionSha256)
      }
    }
    const artifact = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      command: [
        'node',
        relative(root, import.meta.filename)
          .split(sep)
          .join('/'),
        ...args
      ].join(' '),
      environment: {
        node: process.version,
        v8: process.versions.v8,
        platform: process.platform,
        architecture: process.arch,
        osRelease: release(),
        cpuModel: cpus()[0]?.model ?? null,
        availableParallelism: availableParallelism(),
        totalMemoryBytes: totalmem(),
        esbuild: esbuildVersion,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      },
      instrumentation: {
        metric: 'sampled retained heapUsed after two forced full GCs; not absolute peak memory',
        sampleIntervalMs: intervalMs,
        isolation: 'one fresh Node process for each arm, scenario and round',
        finalResult: 'held by a global reference through the final sample',
        observerMemory: 'retained snapshot records contribute small duration-dependent overhead',
        baseline: 'all bundled project source modules read from the pinned baseline commit',
        current: 'all bundled project source modules read and hashed once before any worker runs',
        timing: 'elapsed values include forced GC and are not a speed benchmark'
      },
      instrumentationSha256: Object.fromEntries(
        [
          import.meta.filename,
          join(import.meta.dirname, 'script-child-process.mjs'),
          join(import.meta.dirname, 'counterbalanced-benchmark-schedule.mjs')
        ].map((path) => [relative(root, path).split(sep).join('/'), digest(readFileSync(path))])
      ),
      baselineCommit,
      sources,
      fixture: { events: eventCount, bytes: fixtureBytes.length, sha256: digest(fixtureBytes) },
      schedule,
      measurements
    }
    const output = `${JSON.stringify(artifact, null, 2)}\n`
    const outputPath = argument('--output')
    if (outputPath) {
      writeFileSync(resolve(root, outputPath), output)
    } else {
      process.stdout.write(output)
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

await (args.includes('--worker') ? runWorker() : runComparison())
