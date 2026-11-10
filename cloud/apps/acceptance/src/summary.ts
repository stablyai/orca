// Prints the latest status per catalog feature (non-pass only), leaked resources, and benchmark p50/p95.
//   tsx src/summary.ts
import { CATALOG } from './catalog'
import { loadRuns, percentile } from './run-state'

const runs = loadRuns()
const latest = new Map<string, { status: string; detail: string; run: string }>()
const bench = new Map<string, number[]>()
for (const run of runs) {
  for (const c of run.checks) {
    latest.set(c.id, { status: c.status, detail: c.detail, run: run.runId })
  }
  for (const b of run.benchmarks) {
    if (b.samplesMs.length) {
      bench.set(b.name, b.samplesMs)
    }
  }
  for (const r of run.resources.filter((x) => !x.destroyedAt)) {
    console.log(`LEAK ${run.runId} ${r.kind} ${r.id}`)
  }
}
for (const f of CATALOG) {
  const l = latest.get(f.id)
  if (!l || l.status !== 'pass') {
    console.log(`${(l?.status ?? 'not_landed').padEnd(10)} ${f.id.padEnd(22)} ${f.owner.padEnd(18)} ${(l?.detail ?? '').slice(0, 110)}`)
  }
}
for (const [name, s] of bench) {
  console.log(`bench ${name.padEnd(26)} n=${s.length} p50=${percentile(s, 50)} p95=${percentile(s, 95)}`)
}
for (const run of runs.slice(-6)) {
  for (const n of run.notes.filter((x) => x.startsWith('load') || x.includes('spend'))) {
    console.log(`note ${run.runId}: ${n}`)
  }
}
