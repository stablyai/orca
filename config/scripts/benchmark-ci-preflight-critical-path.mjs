import { readPinnedBunVersion } from './pinned-bun-executable.mjs'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, totalmem } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcessSync } from '@orca/process-host'
import { measurePreflightCommand } from './preflight-benchmark-command.mjs'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'

const comparison = process.argv[2]
if (!['smoke', 'sync-spawn', 'typecheck'].includes(comparison) || process.argv.length !== 3) {
  throw new Error('Use smoke, sync-spawn or typecheck')
}
const root = fileURLToPath(new URL('../..', import.meta.url))
const output = path.join(root, '.build/preflight-benchmark')
mkdirSync(output, { recursive: true })
const env = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
const report = {
  sourceSha: process.env.GITHUB_SHA ?? null,
  comparison,
  host: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    memoryBytes: totalmem(),
    cores: availableParallelism()
  },
  method:
    'Four counterbalanced pairs on one checkout; baseline comes from its first parent. Smoke clears build output each run; native and download caches are warmed for both arms.',
  measurements: []
}
const save = () =>
  writeFileSync(
    path.join(output, `critical-path-${comparison}.json`),
    `${JSON.stringify(report, null, 2)}\n`
  )

function baselineSource(file) {
  const result = runProcessSync({ program: 'git', args: ['show', `HEAD^1:${file}`], cwd: root })
  if (result.code !== 0 || result.outputTruncated) {
    throw new Error(`Cannot read baseline ${file}`)
  }
  return result.stdout
}
async function command(program, args, label) {
  const result = await measurePreflightCommand({ program, args, label, root, output, env })
  if (result.code !== 0 || result.signal || result.timedOut) {
    throw new Error(`${label}: ${JSON.stringify(result)}`)
  }
  return result
}

const baselineName =
  comparison === 'smoke'
    ? 'runtime-serve-terminal-smoke.mjs'
    : comparison === 'typecheck'
      ? 'run-typecheck-projects-in-parallel.mjs'
      : 'check-main-sync-spawn-ratchet.mjs'
const baselineFile = path.join(root, 'config/scripts', `.benchmark-baseline-${baselineName}`)
const runnerFile = path.join(output, 'baseline-smoke-runner.mjs')
const mobileBundle = path.join(output, 'smoke-mobile-web')
writeFileSync(baselineFile, baselineSource(`config/scripts/${baselineName}`))

try {
  if (comparison !== 'smoke') {
    report.host.bun = (
      await command('bun', ['--version'], 'critical-path-bun-version')
    ).stdout.trim()
    if (report.host.bun !== readPinnedBunVersion(root)) {
      throw new Error(`Pin Bun ${readPinnedBunVersion(root)}`)
    }
  }
  if (comparison === 'sync-spawn') {
    const baseline = await import(new URL(`./.benchmark-baseline-${baselineName}`, import.meta.url))
    const candidate = await import('./check-main-sync-spawn-ratchet.mjs')
    const sources = candidate.collectSyncSpawnSources(root)
    let analyzed = 0
    for (const [file, contents] of sources) {
      const before = baseline.collectSyncLaunchUses(file, contents)
      const after = candidate.collectSyncLaunchUses(file, contents)
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        throw new Error(`Findings changed: ${file}`)
      }
      analyzed++
    }
    for (const source of ['import {', 'const broken = ;']) {
      for (const implementation of [baseline, candidate]) {
        let rejected = false
        try {
          implementation.collectSyncLaunchUses('src/main/malformed.ts', source)
        } catch {
          rejected = true
        }
        if (!rejected) {
          throw new Error('Malformed source was accepted')
        }
      }
    }
    report.parity = `Identical counts and symbols for all ${analyzed} production files; both reject malformed syntax.`
  } else if (comparison === 'smoke') {
    await command('pnpm', ['run', 'build:mobile-web'], 'critical-path-smoke-mobile-web')
    rmSync(mobileBundle, { recursive: true, force: true })
    cpSync(path.join(root, 'out', 'mobile-web'), mobileBundle, { recursive: true })
    const steps = [
      [process.execPath, ['config/scripts/ensure-native-runtime.mjs', '--runtime=node']],
      ['pnpm', ['run', 'build:cli']],
      ['pnpm', ['run', 'build:orcad']],
      [process.execPath, [baselineFile, '--target', 'orcad']]
    ]
    writeFileSync(
      runnerFile,
      `import { runProcessSync } from '@orca/process-host';
for (const [program, args] of ${JSON.stringify(steps)}) {
  const result = runProcessSync({ program, args, cwd: ${JSON.stringify(root)}, stdio: 'inherit', timeoutMs: null });
  if (result.code !== 0 || result.signal) process.exit(result.code || 1);
}\n`
    )
    await command('pnpm', ['run', 'build:orcad'], 'critical-path-smoke-warmup')
    report.parity =
      'Both clients must pass pairing, worktree, PTY and execution-host CLI round trips.'
  } else {
    report.parity =
      'Same four projects, Bun version, two processes and two threads; both suites must pass.'
  }

  let findings
  for (const [pair, order] of buildCounterbalancedSchedule(4, 'baseline', 'candidate').entries()) {
    for (const arm of order) {
      let result
      if (comparison === 'smoke') {
        rmSync(path.join(root, 'out'), { recursive: true, force: true })
        // Both measured builds require the same mobile bundle prepared outside the timer.
        cpSync(mobileBundle, path.join(root, 'out', 'mobile-web'), { recursive: true })
        result =
          arm === 'baseline'
            ? await command(process.execPath, [runnerFile], `smoke-${pair}-${arm}`)
            : await command('pnpm', ['run', 'smoke:orcad-terminal'], `smoke-${pair}-${arm}`)
        for (const marker of [
          'terminal round trip OK',
          'execution host CLI round trip OK',
          '[serve-terminal-smoke] PASS'
        ]) {
          if (!result.stdout.includes(marker)) {
            throw new Error(`Smoke skipped ${marker}: ${arm}`)
          }
        }
      } else if (comparison === 'typecheck') {
        result = await command(
          process.execPath,
          [
            arm === 'baseline' ? baselineFile : `config/scripts/${baselineName}`,
            '--compiler=bun',
            '--bun-concurrency=2',
            '--bun-threads=2'
          ],
          `typecheck-${pair}-${arm}`
        )
      } else {
        result = await command(
          'bun',
          [arm === 'baseline' ? baselineFile : `config/scripts/${baselineName}`],
          `sync-spawn-${pair}-${arm}`
        )
        if (findings !== undefined && findings !== result.stdout) {
          throw new Error(`Ratchet findings changed: ${arm}`)
        }
        findings = result.stdout
      }
      report.measurements.push({ pair, arm, ...result })
      save()
      console.log(JSON.stringify({ comparison, pair, arm, durationMs: result.durationMs }))
    }
  }
  report.summary = Object.fromEntries(
    ['baseline', 'candidate'].map((arm) => [
      arm,
      summarizeBenchmarkSamples(
        report.measurements
          .filter((sample) => sample.arm === arm)
          .map((sample) => sample.durationMs)
      )
    ])
  )
  save()
  console.log(JSON.stringify(report.summary))
} finally {
  rmSync(baselineFile, { force: true })
  rmSync(runnerFile, { force: true })
}
