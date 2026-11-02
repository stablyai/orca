import { readPinnedBunVersion } from './pinned-bun-executable.mjs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { measurePreflightCommand } from './preflight-benchmark-command.mjs'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const output = path.join(root, '.build/preflight-benchmark')
mkdirSync(output, { recursive: true })
const bun = process.env.ORCA_BENCHMARK_BUN ?? 'bun'
const report = { sourceSha: process.env.GITHUB_SHA ?? null, measurements: [], comparison: null }
const save = () =>
  writeFileSync(
    path.join(output, 'localization-extraction.json'),
    `${JSON.stringify(report, null, 2)}\n`
  )
async function requireSuccess(program, args, label, env = process.env) {
  const result = await measurePreflightCommand({ program, args, label, root, output, env })
  if (result.code !== 0 || result.signal || result.timedOut) {
    throw new Error(`${label}: ${JSON.stringify(result)}`)
  }
  return result
}
report.bunVersion = (
  await requireSuccess(bun, ['--version'], 'extraction-bun-version')
).stdout.trim()
if (report.bunVersion !== readPinnedBunVersion(root)) {
  throw new Error(`Pin Bun ${readPinnedBunVersion(root)}`)
}
const directory = mkdtempSync(path.join(output, 'extraction-'))
const outputPattern = path.join(directory, '{{language}}.json').split(path.sep).join('/')
const args = [
  'node_modules/i18next-cli/dist/esm/cli.js',
  '--config',
  'config/i18next.config.ts',
  'extract',
  '--sync-primary',
  '--quiet'
]
let catalog
try {
  for (const [pair, order] of buildCounterbalancedSchedule(4, 'node', 'bun').entries()) {
    for (const arm of order) {
      rmSync(path.join(directory, 'en.json'), { force: true })
      const result = await requireSuccess(
        arm === 'bun' ? bun : process.execPath,
        args,
        `extraction-${pair}-${arm}`,
        { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ORCA_I18N_EXTRACTION_OUTPUT: outputPattern }
      )
      const extracted = JSON.stringify(
        JSON.parse(readFileSync(path.join(directory, 'en.json'), 'utf8'))
      )
      if (catalog !== undefined && catalog !== extracted) {
        throw new Error(`Extracted catalog changed: ${arm}`)
      }
      catalog = extracted
      report.measurements.push({ pair, arm, ...result })
      save()
      console.log(JSON.stringify({ pair, arm, durationMs: result.durationMs }))
    }
  }
  report.comparison = Object.fromEntries(
    ['node', 'bun'].map((arm) => [
      arm,
      summarizeBenchmarkSamples(
        report.measurements
          .filter((sample) => sample.arm === arm)
          .map((sample) => sample.durationMs)
      )
    ])
  )
  report.catalogParity = 'identical full extracted catalogs in all eight runs'
  save()
} finally {
  rmSync(directory, { recursive: true, force: true })
}
let findings
for (const [arm, program] of [
  ['node', process.execPath],
  ['bun', bun]
]) {
  const result = await requireSuccess(
    program,
    ['config/scripts/verify-localization-extraction.mjs'],
    `extraction-check-${arm}`
  )
  if (findings !== undefined && findings !== result.stdout) {
    throw new Error(`Extraction gate findings changed: ${arm}`)
  }
  findings = result.stdout
}
report.gateParity = findings
save()
console.log(JSON.stringify(report.comparison))
