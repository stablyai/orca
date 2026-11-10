// Summarizes create-bench / wake-split JSON: p50/p90/p95/p99/max per metric and the slow-host share
// (CPU model "@ 2.50GHz" vs "@ 2.90GHz", see reports/vercel-resume-tail.md).
//   tsx src/bench-summary.ts <file.json> [...]
import { readFileSync } from 'node:fs'
import { percentile } from './run-state'

for (const file of process.argv.slice(2)) {
  const d = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1)!) as {
    samples: Record<string, number[]>
    cpus?: string[]
    hosts?: Array<{ cpu: string; nproc: number; memGb: number; region: string | null }>
    region?: string
    machineSize?: string
    errors?: string[]
  }
  console.log(`== ${file} (region ${d.region}, size ${d.machineSize}${d.errors?.length ? `, errors: ${d.errors.join('; ')}` : ''})`)
  for (const [name, s] of Object.entries(d.samples)) {
    const f = (p: number) => ((percentile(s, p) ?? 0) / 1000).toFixed(2)
    console.log(`  ${name.padEnd(12)} n=${s.length} p50 ${f(50)} p90 ${f(90)} p95 ${f(95)} p99 ${f(99)} max ${(Math.max(...s) / 1000).toFixed(2)} s`)
  }
  const cpus = d.cpus ?? d.hosts?.map((h) => h.cpu) ?? []
  if (cpus.length) {
    const slow = cpus.filter((c) => /@ 2\.50GHz/.test(c)).length
    const fast = cpus.filter((c) => /@ 2\.90GHz/.test(c)).length
    console.log(`  hosts: ${slow}/${cpus.length} slow (@2.50GHz), ${fast}/${cpus.length} fast (@2.90GHz), other ${cpus.length - slow - fast}`)
  }
  if (d.hosts?.length) {
    const sizes = [...new Set(d.hosts.map((h) => `${h.nproc} vCPU / ${h.memGb} GB @ ${h.region}`))]
    console.log(`  sizes: ${sizes.join(', ')}`)
  }
}
