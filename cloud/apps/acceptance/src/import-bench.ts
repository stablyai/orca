// Folds a benchmark JSON ({samples: {phase: ms[]}, ...}) from a desktop/*.ts helper into acceptance-runs/.
//   tsx src/import-bench.ts <file.json> <prefix> <note> [--target <commit>]
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './env'
import type { RunFile } from './run-state'

const [file, prefix, note] = process.argv.slice(2) as [string, string, string]
const ti = process.argv.indexOf('--target')
const data = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1)!) as { samples: Record<string, number[]>; errors?: string[] }
const runId = `bench-${prefix}-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}`
const run: RunFile = {
  runId,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  target: { controlPlaneUrl: config.controlPlaneUrl, billingUrl: config.billingUrl, ...(ti > 0 ? { integrationSha: process.argv[ti + 1] } : {}) },
  checks: [],
  benchmarks: Object.entries(data.samples).map(([phase, samplesMs]) => ({ name: `${prefix}.${phase}`, samplesMs, note })),
  resources: [],
  notes: [note, ...(data.errors?.length ? [`errors: ${data.errors.join('; ')}`] : [])]
}
writeFileSync(join(config.runsDir, `${runId}.json`), JSON.stringify(run, null, 2))
console.log(`${runId}: ${run.benchmarks.map((b) => `${b.name} n=${b.samplesMs.length}`).join(', ')}`)
