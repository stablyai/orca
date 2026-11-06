// Phase 2 load prep: push the director's assignment (epoch 1, cell 'edge') for N synthetic hosts,
// signed as the director signs admin calls. Host ids and user ids match spike/lib.ts startHost.
//   tsx spike/push-assignments.ts --url <origin> --run-tag <tag> --hosts 2000 --key-file <path>
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { SignJWT } from 'jose'
import nacl from 'tweetnacl'
import { parseArgs, pct } from './lib'

const a = parseArgs({ url: 'http://127.0.0.1:8787', 'run-tag': 'p2', hosts: '100', 'key-file': '', issuer: 'https://director.phase2-test.invalid', concurrency: '50' })
const key = new TextEncoder().encode(readFileSync(a['key-file'], 'utf8').trim())
const sha = (s: string) => createHash('sha256').update(s).digest('base64url')

function hostIds(index: number): { relayHostId: string; userId: string } {
  const seed = createHash('sha256').update(`${a['run-tag']}:${index}`).digest()
  const box = nacl.box.keyPair.fromSecretKey(new Uint8Array(seed))
  return {
    relayHostId: createHash('sha256').update(box.publicKey).digest('base64url').slice(0, 16),
    userId: `spike-${a['run-tag']}-${index}`
  }
}

async function push(index: number): Promise<{ status: number; ms: number }> {
  const { relayHostId, userId } = hostIds(index)
  const raw = JSON.stringify({ userId, relayHostId, cellId: 'edge', assignmentEpoch: 1, devices: [] })
  const token = await new SignJWT({ purpose: 'edge-admin', op: 'assign', bodySha256: sha(raw) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(a.issuer)
    .setAudience('orca-relay-edge-admin')
    .setIssuedAt()
    .setExpirationTime('1m')
    .sign(key)
  const started = Date.now()
  const r = await fetch(`${a.url}/__admin/assign`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: raw })
  await r.text()
  return { status: r.status, ms: Date.now() - started }
}

const total = Number(a.hosts)
const results: { status: number; ms: number }[] = []
let next = 0
await Promise.all(
  Array.from({ length: Number(a.concurrency) }, async () => {
    while (next < total) results.push(await push(next++).catch(() => ({ status: 0, ms: 0 })))
  })
)
const byStatus: Record<number, number> = {}
for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
console.log(JSON.stringify({ pushed: total, byStatus, ms: { p50: pct(results.map((r) => r.ms), 0.5), p95: pct(results.map((r) => r.ms), 0.95) } }))
