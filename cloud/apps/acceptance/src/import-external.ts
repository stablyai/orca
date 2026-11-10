// Records a result reported by another workstream (not run by this harness) as its own run file, so
// the report shows its source plainly. Pair it with an auditCap until W9 re-runs it independently.
//   tsx src/import-external.ts <catalogId> <pass|partial|fail> <source> <detail> [evidencePath...]
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './env'
import type { RunFile, Status } from './run-state'

const [id, status, source, detail, ...paths] = process.argv.slice(2) as [string, Status, string, string, ...string[]]
const at = new Date().toISOString()
const runId = `external-${source}-${at.replace(/[-:]/g, '').replace(/\..+/, '')}`
const run: RunFile = {
  runId,
  startedAt: at,
  finishedAt: at,
  target: { controlPlaneUrl: config.controlPlaneUrl, billingUrl: config.billingUrl },
  checks: [
    {
      id,
      status,
      detail: `Reported by ${source} (not run by the W9 harness): ${detail}`,
      evidence: paths.map((path) => ({ kind: 'log' as const, label: path.split('/').at(-1)!, path })),
      startedAt: at,
      durationMs: 0
    }
  ],
  benchmarks: [],
  resources: [],
  notes: [`external result from ${source}`]
}
writeFileSync(join(config.runsDir, `${runId}.json`), JSON.stringify(run, null, 2))
console.log(runId)
