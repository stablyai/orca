// Confirms sandboxes from a desktop run are gone on Vercel (GET /v2/sandboxes/orca-dev-<id> -> 404)
// and records the answer next to the run's results.json. Headless; reads the Vercel token like the
// API acceptance run does.
//   cloud/apps/acceptance/node_modules/.bin/tsx cloud/apps/acceptance/desktop/vercel-check.ts <artifactsDir>
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { vercelRest } from '../src/clients'
import { config } from '../src/env'

const dir = process.argv[2]!
const file = join(dir, 'results.json')
const d = JSON.parse(readFileSync(file, 'utf8'))
const ids = new Set<string>()
const collect = (v: unknown): void => {
  if (typeof v === 'string') {
    for (const m of v.matchAll(/sbx_[a-z0-9]+/g)) ids.add(m[0])
  } else if (v && typeof v === 'object') {
    Object.values(v).forEach(collect)
  }
}
collect(d.steps)
collect(d.cleanup)
const vercel: Record<string, { status: number; vercelStatus: string | null }> = {}
for (const id of ids) {
  const r = await vercelRest('GET', `/v2/sandboxes/orca-dev-${id}`, { projectId: config.vercelProjectId })
  vercel[id] = { status: r.status, vercelStatus: r.json?.sandbox?.status ?? r.json?.error?.code ?? null }
}
d.vercel = { checkedAt: new Date().toISOString(), sandboxes: vercel }
for (const s of d.steps) {
  const mine = [...JSON.stringify(s).matchAll(/sbx_[a-z0-9]+/g)].map((m) => m[0])
  if (mine.length) s.vercel = Object.fromEntries([...new Set(mine)].map((id) => [id, vercel[id]]))
}
writeFileSync(file, JSON.stringify(d, null, 2))
console.log(JSON.stringify(vercel, null, 1))
