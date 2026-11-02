import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { measurePreflightCommand } from './preflight-benchmark-command.mjs'
import ts from 'typescript-api'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'
import { resolveOxlintInvocation } from './oxlint-cli-invocation.mjs'
import { resolveOxcCliInvocation } from './oxc-cli-invocation.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const output = path.join(root, '.build/preflight-benchmark')
const baseline = path.join(output, 'baseline')
mkdirSync(output, { recursive: true })
const report = {
  sourceSha: process.env.GITHUB_SHA ?? null,
  host: { platform: process.platform, arch: process.arch, node: process.version },
  measurements: [],
  comparisons: {}
}
const save = () =>
  writeFileSync(path.join(output, 'static-analysis.json'), `${JSON.stringify(report, null, 2)}\n`)
const command = (program, args, label) =>
  measurePreflightCommand({
    program,
    args,
    label,
    root,
    output,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 180_000
  })
async function requireSuccess(program, args, label) {
  const result = await command(program, args, label)
  if (result.code !== 0 || result.signal || result.timedOut) {
    throw new Error(`${label}: ${JSON.stringify(result)}`)
  }
  return result
}
const bun = process.env.ORCA_BENCHMARK_BUN ?? 'bun'
report.host.bun = (await requireSuccess(bun, ['--version'], 'bun-version')).stdout.trim()
if (report.host.bun !== '1.4.3') {
  throw new Error('Pin Bun 1.4.3')
}
await requireSuccess(process.execPath, ['config/scripts/sync-anti-slop-plugin.mjs'], 'sync-plugin')
rmSync(baseline, { recursive: true, force: true })
cpSync(path.join(root, '.anti-slop-plugin'), path.join(baseline, 'src'), { recursive: true })
// Reverse the committed patch so both arms use the same pinned upstream package.
await requireSuccess(
  'git',
  [
    'apply',
    '--reverse',
    '--directory=.build/preflight-benchmark/baseline',
    'config/patches/oxlint-plugin-anti-slop@0.1.2.patch'
  ],
  'reverse-patch'
)
const configText = readFileSync(path.join(root, 'config/oxlint-anti-slop.json'), 'utf8')
const { config, error } = ts.parseConfigFileTextToJson('config/oxlint-anti-slop.json', configText)
if (error) {
  throw new Error('Invalid anti-slop configuration')
}
for (const [arm, plugin] of [
  ['baseline', path.join(baseline, 'src/index.ts')],
  ['patched', path.join(root, '.anti-slop-plugin/index.ts')]
]) {
  writeFileSync(
    path.join(output, `${arm}.json`),
    JSON.stringify({ ...config, jsPlugins: [{ name: 'anti-slop', specifier: plugin }] })
  )
}
const oxlint = resolveOxlintInvocation(root)
const tsx = resolveOxcCliInvocation('tsx', 'tsx', root)
for (const [arm, directory] of [
  ['baseline', path.join(baseline, 'src')],
  ['patched', path.join(root, '.anti-slop-plugin')]
]) {
  for (const rule of ['no-object-parameters', 'no-unknown-type-aliases']) {
    const fixture = path.join(directory, 'rules', `${rule}.test.ts`)
    await requireSuccess(tsx.command, [...tsx.prefixArgs, fixture], `fixtures-${arm}-${rule}-node`)
  }
}
// RuleTester uses V8 raw transfer and rejects Bun; exercise Bun through the real CLI.
const fixturePath = path.join(output, 'anti-slop-invalid-fixture.ts')
writeFileSync(
  fixturePath,
  'type InvalidAlias = unknown; type ObjectAlias = object; export function consume(value: ObjectAlias): void {}\n'
)
let fixtureDiagnostics
for (const [runtime, flags] of [
  [process.execPath, []],
  [bun, []],
  [bun, ['--smol']]
]) {
  const result = await command(
    runtime,
    [
      ...flags,
      ...oxlint.prefixArgs,
      '--config',
      path.join(output, 'patched.json'),
      fixturePath,
      '--format=json'
    ],
    `cli-fixture-${path.basename(runtime)}-${flags.length}`
  )
  const findings = JSON.parse(result.stdout).diagnostics
  if (
    result.code !== 1 ||
    !findings.some((finding) => finding.code?.includes('no-object-parameters')) ||
    !findings.some((finding) => finding.code?.includes('no-unknown-type-aliases'))
  ) {
    throw new Error(`Invalid fixture did not produce expected findings: ${JSON.stringify(result)}`)
  }
  const normalized = JSON.stringify(findings)
  if (fixtureDiagnostics !== undefined && fixtureDiagnostics !== normalized) {
    throw new Error('Runtime fixture diagnostics differ')
  }
  fixtureDiagnostics = normalized
}
const lintArgs = (arm) => [
  ...oxlint.prefixArgs,
  '--config',
  path.join(output, `${arm}.json`),
  'src',
  'config',
  'tests',
  'mobile',
  '--deny-warnings',
  '--format=json'
]
for (const [comparison, first, second] of [
  ['anti-slop-patch', 'baseline', 'patched'],
  ['anti-slop-runtime', 'node', 'bun'],
  ['anti-slop-smol', 'node', 'bun-smol'],
  ['import-guard-runtime', 'node', 'bun']
]) {
  let diagnostics
  for (const [pair, arms] of buildCounterbalancedSchedule(4, first, second).entries()) {
    for (const arm of arms) {
      const program = arm.startsWith('bun') ? bun : process.execPath
      const args =
        comparison === 'import-guard-runtime'
          ? ['config/scripts/check-process-host-imports.mjs']
          : lintArgs(comparison === 'anti-slop-patch' ? arm : 'patched')
      const result = await requireSuccess(
        program,
        arm === 'bun-smol' ? ['--smol', ...args] : args,
        `${comparison}-${pair}-${arm}`
      )
      if (comparison !== 'import-guard-runtime') {
        const findings = JSON.stringify(JSON.parse(result.stdout).diagnostics)
        if (diagnostics !== undefined && diagnostics !== findings) {
          throw new Error(`Diagnostics changed: ${comparison}`)
        }
        diagnostics = findings
      }
      report.measurements.push({ comparison, pair, arm, ...result })
      save()
      console.log(
        JSON.stringify({
          comparison,
          pair,
          arm,
          durationMs: result.durationMs,
          peakRssKiB: result.peakRssKiB
        })
      )
    }
  }
  report.comparisons[comparison] = Object.fromEntries(
    [first, second].map((arm) => [
      arm,
      summarizeBenchmarkSamples(
        report.measurements
          .filter((sample) => sample.comparison === comparison && sample.arm === arm)
          .map((sample) => sample.durationMs)
      )
    ])
  )
  save()
}
const guardProbeDirectory = mkdtempSync(path.join(root, 'src/main/preflight-import-probe-'))
const guardProbe = path.join(guardProbeDirectory, 'forbidden-process-import.ts')
try {
  writeFileSync(
    guardProbe,
    "import { spawn } from 'node:child_process'\nexport const forbiddenSpawn = spawn\n"
  )
  for (const runtime of [process.execPath, bun]) {
    const result = await command(
      runtime,
      ['config/scripts/check-process-host-imports.mjs'],
      `guard-invalid-${path.basename(runtime)}`
    )
    if (
      result.code !== 1 ||
      !`${result.stdout}${result.stderr}`.includes('forbidden-process-import.ts')
    ) {
      throw new Error(`Import guard did not reject its fixture: ${JSON.stringify(result)}`)
    }
  }
} finally {
  rmSync(guardProbeDirectory, { recursive: true, force: true })
}
for (const [pair, arms] of buildCounterbalancedSchedule(4, 'baseline', 'optimized').entries()) {
  for (const arm of arms) {
    const runtime = arm === 'optimized' ? bun : process.execPath
    const start = performance.now()
    const processes = await Promise.all([
      requireSuccess(
        process.execPath,
        [...oxlint.prefixArgs, '--format=json'],
        `early-${pair}-${arm}-root-lint`
      ),
      requireSuccess(
        runtime,
        arm === 'optimized' ? ['--smol', ...lintArgs('patched')] : lintArgs('baseline'),
        `early-${pair}-${arm}-anti-slop`
      ),
      requireSuccess(
        runtime,
        ['config/scripts/check-process-host-imports.mjs'],
        `early-${pair}-${arm}-import-guard`
      )
    ])
    const durationMs = performance.now() - start
    report.measurements.push({ comparison: 'early-phase', pair, arm, durationMs, processes })
    save()
    console.log(JSON.stringify({ comparison: 'early-phase', pair, arm, durationMs }))
  }
}
report.comparisons['early-phase'] = Object.fromEntries(
  ['baseline', 'optimized'].map((arm) => [
    arm,
    summarizeBenchmarkSamples(
      report.measurements
        .filter((sample) => sample.comparison === 'early-phase' && sample.arm === arm)
        .map((sample) => sample.durationMs)
    )
  ])
)
save()
const summary = `Static analysis comparisons on ${process.platform}/${process.arch}\n\n\`\`\`json\n${JSON.stringify(report.comparisons, null, 2)}\n\`\`\`\n\nBoth upstream rule suites pass under Node; real CLI fixtures agree under Node and Bun. Full-scan diagnostics agree between the compared arms.\n`
writeFileSync(path.join(output, 'static-analysis.md'), summary)
if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' })
}
