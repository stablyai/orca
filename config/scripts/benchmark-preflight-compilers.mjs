import { readPinnedBunVersion } from './pinned-bun-executable.mjs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, totalmem } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { measurePreflightCommand } from './preflight-benchmark-command.mjs'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'
import {
  TYPECHECK_PROJECTS,
  admissibleHeapGib,
  planTypecheckBatches,
  resolveProjectCompiler
} from './run-typecheck-projects-in-parallel.mjs'

const parityOnly = process.argv.slice(2).includes('--parity-only')
if (process.argv.slice(2).some((argument) => argument !== '--parity-only')) {
  throw new Error('Use --parity-only or no arguments')
}
const root = fileURLToPath(new URL('../..', import.meta.url))
const output = path.join(root, '.build/preflight-benchmark')
const reportName = parityOnly ? 'compiler-parity' : 'compilers'
mkdirSync(output, { recursive: true })
const bun = process.env.ORCA_BENCHMARK_BUN ?? 'bun'
const env = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', GOMAXPROCS: '4' }
const report = {
  sourceSha: process.env.GITHUB_SHA ?? null,
  host: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    memoryBytes: totalmem(),
    cores: availableParallelism()
  },
  method: parityOnly
    ? 'Diagnostic probes and normalized file-list parity for every registered project; no timing comparison.'
    : 'Four counterbalanced pairs per comparison. Cold removes build state, not filesystem caches. Warm immediately follows its cold run. Same commit and project registry for every arm.',
  measurements: [],
  comparisons: {},
  parity: []
}
const save = () =>
  writeFileSync(path.join(output, `${reportName}.json`), `${JSON.stringify(report, null, 2)}\n`)
const command = (program, args, label) =>
  measurePreflightCommand({
    program,
    args,
    label,
    root,
    output,
    env,
    ...(process.platform === 'win32' ? { timeoutMs: 900_000 } : {})
  })
const version = await command(bun, ['--version'], 'bun-version')
if (version.code !== 0 || version.stdout.trim() !== readPinnedBunVersion(root)) {
  throw new Error(`Pin Bun ${readPinnedBunVersion(root)} for this comparison`)
}
report.host.bun = version.stdout.trim()
report.host.typescript = JSON.parse(
  readFileSync(path.join(root, 'node_modules/typescript/package.json'))
).version
const nativeBatches = planTypecheckBatches(TYPECHECK_PROJECTS, {
  budgetGib: Math.min(12, admissibleHeapGib(totalmem())),
  parallelism: Math.min(4, availableParallelism())
})
function invocation(config, arm, extra = []) {
  return arm === 'native'
    ? [
        process.execPath,
        [
          resolveProjectCompiler(config, root),
          '--noEmit',
          '-p',
          config,
          '--pretty',
          'false',
          ...extra
        ]
      ]
    : [
        bun,
        [
          'check',
          '-p',
          config,
          '--threads',
          arm === 'bun-pair' ? '2' : '4',
          '--no-pretty',
          '--all',
          ...extra
        ]
      ]
}
async function suite(arm, state, pair, comparison) {
  const batches =
    arm === 'native'
      ? nativeBatches
      : arm === 'bun-pair'
        ? [TYPECHECK_PROJECTS.slice(0, 2), TYPECHECK_PROJECTS.slice(2)]
        : TYPECHECK_PROJECTS.map((project) => [project])
  const start = performance.now()
  const projects = []
  for (const batch of batches) {
    projects.push(
      ...(await Promise.all(
        batch.map(async ({ config }) => {
          const [program, args] = invocation(config, arm)
          return {
            config,
            ...(await command(
              program,
              args,
              `${comparison}-${pair}-${arm}-${state}-${path.basename(config)}`
            ))
          }
        })
      ))
    )
  }
  const measurement = {
    comparison,
    pair,
    arm,
    state,
    durationMs: performance.now() - start,
    projects
  }
  report.measurements.push(measurement)
  save()
  console.log(
    JSON.stringify({
      comparison,
      pair,
      arm,
      state,
      durationMs: measurement.durationMs,
      codes: projects.map((project) => project.code),
      peakRssKiB: projects.map((project) => project.peakRssKiB)
    })
  )
  if (projects.some((project) => project.code !== 0 || project.timedOut || project.signal)) {
    throw new Error(`Compiler failed: ${JSON.stringify(projects)}`)
  }
}
function clearBuildState() {
  for (const { config } of TYPECHECK_PROJECTS) {
    rmSync(path.join(root, config.replace(/\.json$/, '.tsbuildinfo')), { force: true })
  }
}
if (!parityOnly) {
  for (const [comparison, first, second] of [
    ['native-vs-bun', 'native', 'bun'],
    ['bun-serial-vs-pair', 'bun', 'bun-pair']
  ]) {
    for (const [pair, arms] of buildCounterbalancedSchedule(4, first, second).entries()) {
      for (const arm of arms) {
        clearBuildState()
        await suite(arm, arm === 'native' ? 'cold' : 'full', pair, comparison)
        if (arm === 'native') {
          await suite(arm, 'warm', pair, comparison)
        }
      }
    }
    report.comparisons[comparison] = {}
    for (const arm of [first, second]) {
      for (const state of arm === 'native' ? ['cold', 'warm'] : ['full']) {
        const samples = report.measurements.filter(
          (sample) =>
            sample.comparison === comparison && sample.arm === arm && sample.state === state
        )
        report.comparisons[comparison][`${arm}-${state}`] = summarizeBenchmarkSamples(
          samples.map((sample) => sample.durationMs)
        )
      }
    }
    save()
  }
}
const probeRoots = new Map([
  ['config/tsconfig.node.json', 'src/main'],
  ['config/tsconfig.tc.web.json', 'src/renderer/src'],
  ['config/tsconfig.tc.cli.json', 'src/cli'],
  ['config/tsconfig.test.pane-launch.json', 'src/shared'],
  ['src/packages/process-host/tsconfig.test.json', 'src/packages/process-host/src']
])
for (const { config } of TYPECHECK_PROJECTS) {
  const probeRoot = probeRoots.get(config)
  if (!probeRoot) {
    throw new Error(`Register an included probe directory for ${config}`)
  }
  const directory = mkdtempSync(path.join(root, probeRoot, 'preflight-benchmark-probe-'))
  const probe = path.join(directory, 'preflight-typecheck-benchmark-probe.ts')
  try {
    writeFileSync(
      probe,
      [
        'export const preflightBenchmarkValue: number = "typecheck must reject this"',
        'export function preflightBenchmarkReturn(value: number): string { return value }',
        'export const preflightBenchmarkNull: string = null',
        'export function preflightBenchmarkImplicit(value) { return value }'
      ].join('\n'),
      { flag: 'wx' }
    )
    for (const arm of ['native', 'bun']) {
      const [program, args] = invocation(config, arm)
      const result = await command(program, args, `probe-${path.basename(config)}-${arm}`)
      report.parity.push({ config, arm, ...result })
      save()
      if (
        result.code !== 1 ||
        (`${result.stdout}${result.stderr}`.match(/: error TS2322:/g) ?? []).length !== 3
      ) {
        throw new Error(`Missing expected diagnostic: ${arm} ${config}`)
      }
    }
    const errors = report.parity
      .filter((sample) => sample.config === config && sample.code === 1)
      .map((sample) =>
        `${sample.stdout}${sample.stderr}`
          .split(/\r?\n/)
          .filter((line) => line.includes(': error TS'))
      )
    if (JSON.stringify(errors[0]) !== JSON.stringify(errors[1])) {
      throw new Error(`Compiler diagnostics differ: ${config}`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  for (const arm of ['native', 'bun']) {
    const [program, args] = invocation(config, arm, ['--listFilesOnly'])
    const result = await command(program, args, `files-${path.basename(config)}-${arm}`)
    if (result.code !== 0) {
      throw new Error(`Could not enumerate ${arm} ${config}: ${result.stderr}`)
    }
    report.parity.push({
      config,
      arm,
      files: result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => path.isAbsolute(line) || line.startsWith('bundled:///libs/'))
        // Bun embeds the standard library; compare its names with native TypeScript's disk paths.
        .map((line) =>
          line.startsWith('bundled:///libs/') ||
          /\/(?:@typescript\/typescript-[^/]+|typescript)\/lib\/lib\.[^/]+\.d\.ts$/.test(
            line.replaceAll('\\', '/')
          )
            ? `typescript-lib:${path.basename(line)}`
            : path.normalize(line)
        )
        .sort()
    })
  }
  const [nativeFiles, bunFiles] = report.parity
    .filter((sample) => sample.config === config && sample.files)
    .map((sample) => sample.files)
  save()
  if (JSON.stringify(nativeFiles) !== JSON.stringify(bunFiles)) {
    throw new Error(`Compiler file selection differs: ${config}`)
  }
  save()
}
const summary = `Compiler comparison on ${process.platform}/${process.arch}, ${report.host.cores} cores\n\n\`\`\`json\n${JSON.stringify(report.comparisons, null, 2)}\n\`\`\`\n\nAll project file lists match after normalizing embedded standard-library names; both compilers report identical diagnostics for assignment, return-type, strict-null and implicit-any probes under each project's existing settings.\n`
writeFileSync(path.join(output, `${reportName}.md`), summary)
if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' })
}
