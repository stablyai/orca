// W9 simulator run for life.read-asleep-phone: the Orca mobile app shows a SLEEPING workspace's
// "Latest from this workspace" without waking it. Driven in phases so the sim steps (CDP identity
// install, deep link, screenshot) run between them; see run-read-asleep-sim.sh.
//   tsx mobile/read-asleep-sim.ts enroll     device session (Ed25519 phone key) for the owner; writes the identity file (0600)
//   tsx mobile/read-asleep-sim.ts readerkey  waits for the app's own mobile reader key (GET /v1/reader-keys)
//   tsx mobile/read-asleep-sim.ts workspace  creates the workspace, writes NOTES.md + a commit with a marker, sleeps it
//   tsx mobile/read-asleep-sim.ts provider   Vercel GET of the sandbox (no-wake check)
//   tsx mobile/read-asleep-sim.ts cleanup    destroys the sandbox, revokes the device session + reader key, Vercel 404 check
// State (ids, timings; no secrets) lives in $W9M_DIR/state.json; the phone seed only in identity.json (0600).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto'
import { control, vercel, vercelRest } from '../src/clients'
import { config } from '../src/env'
import type { Identity } from '../src/tokens'

const DIR = process.env.W9M_DIR ?? '/tmp/w9m'
const STATE = join(DIR, 'state.json')
const owner: Identity = { sub: process.env.W9M_OWNER ?? 'w9-mobile' }
const state: Record<string, any> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const providerStatus = async (id: string) => {
  const r = await vercelRest('GET', `/v2/sandboxes/orca-dev-${id}`, { projectId: config.vercelProjectId })
  return { http: r.status, sandbox: r.json?.sandbox?.status ?? null, session: r.json?.session?.status ?? null }
}

const phase = process.argv[2]
if (phase === 'enroll') {
  // The app's identity is a 32-byte Ed25519 seed (tweetnacl fromSeed == RFC 8032 private key).
  const seed = randomBytes(32)
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed])
  const pub = Buffer.from(createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x!, 'base64')
  const t0 = performance.now()
  const r = await control.as(owner, 'POST', '/v1/device-sessions', { label: 'W9 eval iPhone (sim)', platform: 'ios', publicKeyB64: pub.toString('base64') })
  const ds = r.body?.deviceSession?.id
  console.log('enroll', r.status, ds ?? JSON.stringify(r.body).slice(0, 200))
  if (!ds) process.exit(1)
  writeFileSync(
    join(DIR, 'identity.json'),
    JSON.stringify({ seedB64: seed.toString('base64'), enrollment: { controlPlaneUrl: config.controlPlaneUrl, deviceSessionId: ds, label: 'W9 eval iPhone (sim)', enrolledAt: Date.now() } }),
    { mode: 0o600 }
  )
  Object.assign(state, { owner: `dev:${owner.sub}`, deviceSessionId: ds, enrollMs: Math.round(performance.now() - t0) })
  save()
} else if (phase === 'readerkey') {
  for (let i = 0; i < 40; i++) {
    const r = await control.as(owner, 'GET', '/v1/reader-keys')
    const keys: any[] = r.body?.keys ?? r.body?.readerKeys ?? []
    const mobile = keys.find((k) => (k.deviceKind ?? k.kind) === 'mobile')
    if (mobile) {
      state.readerKeyId = mobile.id
      save()
      console.log('reader key', mobile.id, mobile.deviceKind ?? mobile.kind, mobile.deviceLabel ?? mobile.label)
      process.exit(0)
    }
    if (i === 0) console.log('reader-keys', r.status, `${keys.length} keys`)
    await sleep(3000)
  }
  console.log('no mobile reader key registered by the app')
  process.exit(1)
} else if (phase === 'workspace') {
  const marker = `W9MOB${randomBytes(3).toString('hex').toUpperCase()}`
  const t0 = performance.now()
  const created = await control.as(owner, 'POST', '/v1/sandboxes', {
    workspaceId: `w9-mobile-${marker.toLowerCase()}`,
    machineSize: 'standard',
    title: `W9 phone read ${marker}`,
    repo: { url: 'https://github.com/octocat/Hello-World' }
  })
  const id = created.body?.sandbox?.id
  console.log('create', created.status, created.ms, 'ms', id ?? JSON.stringify(created.body).slice(0, 200))
  if (!id) process.exit(1)
  Object.assign(state, { marker, sandboxId: id, createMs: created.ms })
  save()
  const root = created.body.connection.projectRoot
  const script = [
    `cd ${root}`,
    `git checkout -q -b w9-${marker}`,
    `printf '# Notes\\n\\nW9 phone read-asleep marker: ${marker}\\n' > NOTES.md`,
    `git add NOTES.md`,
    `git -c user.name='W9 eval' -c user.email='w9@example.invalid' commit -q -m 'Add NOTES.md (${marker})'`,
    `printf 'Edited after the commit: ${marker}\\n' >> NOTES.md`,
    `git log --oneline -1; git status --short; git branch --show-current`
  ].join(' && ')
  const ex: any = await vercel().runCommand(created.body.sandbox.session!.id, { command: 'bash', args: ['-c', script], timeoutMs: 60_000 })
  const out = String(ex?.stdout ?? ex?.output ?? JSON.stringify(ex)).trim()
  console.log('vm:', out.slice(0, 400))
  state.vmOutput = out.slice(0, 400)
  const s0 = performance.now()
  const sus = await control.as(owner, 'POST', `/v1/sandboxes/${id}/suspend`)
  state.suspendStatus = sus.status
  state.suspendMs = Math.round(performance.now() - s0)
  state.readSnapshotAt = sus.body?.sandbox?.readSnapshotAt ?? null
  state.afterSuspend = await providerStatus(id)
  state.workspaceSetupMs = Math.round(performance.now() - t0)
  save()
  console.log('suspend', sus.status, state.suspendMs, 'ms; provider', JSON.stringify(state.afterSuspend))
  const g = await control.as(owner, 'GET', `/v1/sandboxes/${id}`)
  console.log('control-plane view', g.body?.sandbox?.status, 'readSnapshotAt', g.body?.sandbox?.readSnapshotAt ?? g.body?.readSnapshotAt ?? '?')
} else if (phase === 'provider') {
  const p = await providerStatus(state.sandboxId)
  const g = await control.as(owner, 'GET', `/v1/sandboxes/${state.sandboxId}`)
  const label = process.argv[3] ?? 'check'
  state.provider = { ...(state.provider ?? {}), [label]: { ...p, controlPlane: g.body?.sandbox?.status, at: new Date().toISOString() } }
  save()
  console.log(label, JSON.stringify(state.provider[label]))
} else if (phase === 'cleanup') {
  const out: Record<string, unknown> = {}
  if (state.sandboxId) {
    const d = await control.as(owner, 'DELETE', `/v1/sandboxes/${state.sandboxId}`)
    out.destroy = d.status
    for (let i = 0; i < 20; i++) {
      const p = await providerStatus(state.sandboxId)
      out.vercelAfterDestroy = p.http
      if (p.http === 404) break
      await sleep(3000)
    }
  }
  if (state.deviceSessionId) {
    out.revokeDeviceSession = (await control.as(owner, 'DELETE', `/v1/device-sessions/${state.deviceSessionId}`)).status
  }
  if (state.readerKeyId) {
    out.readerKeyDelete = (await control.as(owner, 'DELETE', `/v1/reader-keys/${state.readerKeyId}`)).status
  }
  const keys = await control.as(owner, 'GET', '/v1/reader-keys')
  out.liveReaderKeysLeft = (keys.body?.keys ?? keys.body?.readerKeys ?? []).length
  const list = await control.as(owner, 'GET', '/v1/sandboxes')
  out.liveSandboxesLeft = (list.body?.sandboxes ?? []).filter((s: any) => !['destroyed', 'deleted'].includes(s.status)).length
  state.cleanup = out
  save()
  console.log(JSON.stringify(out))
} else {
  console.log('phases: enroll | readerkey | workspace | provider [label] | cleanup')
}
