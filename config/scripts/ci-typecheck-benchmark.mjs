import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { availableParallelism, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'
import { describeProcessFailure, runProcessSync } from './script-child-process.mjs'

const { values } = parseArgs({
  options: { bun: { type: 'string' }, pairs: { type: 'string', default: '2' } }
})
assert(values.bun, '--bun must name the isolated executable')
const schedule = buildCounterbalancedSchedule(Number(values.pairs), 'typescript', 'bun')
const root = resolve(import.meta.dirname, '../..')
const output = join(root, '.build/typecheck-benchmark')
const temporary = mkdtempSync(join(tmpdir(), 'orca-typecheck-benchmark-'))
const config = join(root, 'config')
const runner = join(root, 'config/scripts/run-typecheck-projects-in-parallel.mjs')
const tsc = join(root, 'node_modules/typescript/bin/tsc')
mkdirSync(output, { recursive: true })
const samples = []

function buildInfoFiles(directory) {
  return readdirSync(directory).filter((file) => file.endsWith('.tsbuildinfo'))
}

function captureCache(name) {
  const directory = join(temporary, name)
  mkdirSync(directory)
  for (const file of buildInfoFiles(config)) {
    cpSync(join(config, file), join(directory, file))
  }
  return directory
}

function restoreCache(directory) {
  for (const file of buildInfoFiles(config)) {
    rmSync(join(config, file))
  }
  for (const file of buildInfoFiles(directory)) {
    cpSync(join(directory, file), join(config, file))
  }
}

function command(program, args, env = process.env) {
  return runProcessSync({ program, args, env, cwd: root, timeoutMs: 600_000 })
}

function success(program, args) {
  const result = command(program, args)
  assert.equal(result.code, 0, describeProcessFailure(result))
  return result.stdout.trim()
}

function typecheck(engine, cacheMode, pair) {
  const env = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  delete env.ORCA_TYPECHECK_BUN
  if (engine === 'bun') {
    env.ORCA_TYPECHECK_BUN = values.bun
  }
  const start = performance.now()
  const result = command(process.execPath, [runner], env)
  const milliseconds = performance.now() - start
  const sample = { engine, cacheMode, pair, milliseconds, exitCode: result.code }
  samples.push(sample)
  writeFileSync(
    join(output, `${cacheMode}-${pair}-${engine}.log`),
    `${result.stdout}\n${result.stderr}`
  )
  writeFileSync(join(output, 'samples.json'), `${JSON.stringify(samples, null, 2)}\n`)
  console.log(JSON.stringify(sample))
  assert.equal(result.code, 0, describeProcessFailure(result))
}

function verifyTypeErrors() {
  const fixture = join(temporary, 'invalid-project')
  mkdirSync(fixture)
  writeFileSync(join(fixture, 'producer.ts'), 'export const value = 42\n')
  writeFileSync(
    join(fixture, 'consumer.ts'),
    "import { value } from './producer'\nconst text: string = value\n"
  )
  const project = join(fixture, 'tsconfig.json')
  writeFileSync(
    project,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        types: [],
        target: 'ES2022',
        module: 'Preserve'
      },
      include: ['*.ts']
    })
  )
  for (const engine of ['typescript', 'bun']) {
    const result =
      engine === 'bun'
        ? command(values.bun, ['check', '-p', project, '--no-pretty'])
        : command(process.execPath, [tsc, '--noEmit', '-p', project, '--pretty', 'false'])
    writeFileSync(
      join(output, `invalid-project-${engine}.log`),
      `${result.stdout}\n${result.stderr}`
    )
    assert.equal(result.code, 1, `${engine} did not reject the invalid project`)
    assert.match(result.stdout, /consumer\.ts.*TS2322/)
  }
}

const initial = captureCache('restored-cache')
const cold = captureCache('cold-cache')
for (const file of buildInfoFiles(cold)) {
  rmSync(join(cold, file))
}
const cacheManifest = buildInfoFiles(initial).map((file) => ({
  file,
  sha256: createHash('sha256')
    .update(readFileSync(join(initial, file)))
    .digest('hex')
}))

try {
  const identity = {
    source: success('git', ['rev-parse', 'HEAD']),
    runner: process.env.RUNNER_NAME,
    platform: process.platform,
    arch: process.arch,
    cores: availableParallelism(),
    memoryBytes: totalmem(),
    node: process.version,
    typescript: JSON.parse(readFileSync(join(root, 'node_modules/typescript/package.json')))
      .version,
    bun: success(values.bun, ['--revision']),
    restoredCacheKey: process.env.TYPECHECK_RESTORED_CACHE_KEY || null,
    restoredCacheManifest: cacheManifest
  }
  verifyTypeErrors()
  for (const [cacheMode, cache] of [
    ['restored', initial],
    ['cold', cold]
  ]) {
    for (const [pair, order] of schedule.entries()) {
      for (const engine of order) {
        restoreCache(cache)
        typecheck(engine, cacheMode, pair)
      }
    }
  }
  // The final cold arm is TypeScript, so this is the same-source incremental state it just wrote.
  const warm = captureCache('warm-cache')
  assert(buildInfoFiles(warm).length > 0, 'TypeScript wrote no incremental state')
  for (const [pair, order] of schedule.entries()) {
    for (const engine of order) {
      restoreCache(warm)
      typecheck(engine, 'warm', pair)
    }
  }
  const comparison = ['restored', 'cold', 'warm'].map((cacheMode) => {
    const summary = (engine) =>
      summarizeBenchmarkSamples(
        samples
          .filter((sample) => sample.cacheMode === cacheMode && sample.engine === engine)
          .map((sample) => sample.milliseconds)
      )
    const typescript = summary('typescript')
    const bun = summary('bun')
    return {
      cacheMode,
      typescript,
      bun,
      savedMs: typescript.medianMs - bun.medianMs,
      lessTimePercent: 100 * (1 - bun.medianMs / typescript.medianMs)
    }
  })
  const report = {
    identity,
    samples,
    comparison,
    invalidImportedTypeRejectedByBoth: true,
    scope:
      'Whole-project scheduler wall time on one runner, alternating checker order; restored state reset before each arm. Setup and cache transfer excluded.'
  }
  writeFileSync(join(output, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`)
  const markdown = `${[
    '| Cache state | TypeScript | Bun | Seconds saved | Less time |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...comparison.map(
      ({ cacheMode, typescript, bun, savedMs, lessTimePercent }) =>
        `| ${cacheMode} | ${(typescript.medianMs / 1000).toFixed(2)}s | ${(bun.medianMs / 1000).toFixed(2)}s | ${(savedMs / 1000).toFixed(2)}s | ${lessTimePercent.toFixed(1)}% |`
    ),
    '',
    `Source: \`${identity.source}\`; Bun: \`${identity.bun}\`; TypeScript: \`${identity.typescript}\`.`,
    '',
    'Both compilers rejected an invalid imported type. All full-project checks passed.',
    '',
    report.scope
  ].join('\n')}\n`
  writeFileSync(join(output, 'comparison.md'), markdown)
  console.log(markdown)
} finally {
  restoreCache(initial)
  rmSync(temporary, { recursive: true, force: true })
}
