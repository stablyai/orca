// Safety and cost checks: kill switch, caps, orphan sweep, cleanup. The dev Worker is shared with
// other workstreams, so the kill switch is flipped without drain and only for a few seconds.
import { control, vercel, vercelRest } from '../clients'
import { config } from '../env'
import { log, type Check } from '../context'

export const opsChecks: Record<string, Check> = {
  'ops.kill-switch': async (ctx) => {
    const p = await ctx.primary()
    let created = 0
    let createWhileOff: number | null = null
    let resumeWhileOff: number | null = null
    const before = await control.operator('GET', '/v1/internal/status')
    if (before.body?.killSwitch) {
      return { status: 'skipped', detail: 'kill switch already on (someone else is using it); not touching it' }
    }
    try {
      const on = await control.operator('POST', '/v1/internal/kill-switch', { enabled: true, drain: false })
      if (on.status !== 200) {
        return { status: 'fail', detail: `kill switch on -> ${on.status}` }
      }
      const c = await control.as(ctx.solo, 'POST', '/v1/sandboxes', { workspaceId: 'w9-killed', machineSize: 'standard' })
      createWhileOff = c.status
      if (c.status === 200) {
        created++
        await control.as(ctx.solo, 'DELETE', `/v1/sandboxes/${c.body.sandbox.id}`)
      }
      // The primary is running; resume of a running sandbox must still be refused while killed.
      resumeWhileOff = (await control.as(ctx.solo, 'POST', `/v1/sandboxes/${p.sandbox.id}/resume`)).status
    } finally {
      await control.operator('POST', '/v1/internal/kill-switch', { enabled: false })
    }
    const after = await control.operator('GET', '/v1/internal/status')
    const ok = createWhileOff === 503 && resumeWhileOff === 503 && after.body?.killSwitch === false && created === 0
    return {
      status: ok ? 'pass' : 'fail',
      detail: `while on: create ${createWhileOff}, resume ${resumeWhileOff} (want 503 maintenance); off again: ${after.body?.killSwitch === false}. Drain mode not exercised on the shared dev Worker.`
    }
  },

  'ops.caps': async (ctx) => {
    // Rate limit: every create request consumes a token before the body is parsed, so invalid
    // bodies probe the limiter without starting any VM. Own account so other checks are unaffected.
    const who = { sub: `w9-rate-${ctx.run.file.runId}` }
    const statuses: number[] = []
    for (let i = 0; i < 12; i++) {
      statuses.push((await control.as(who, 'POST', '/v1/sandboxes', { bogus: true })).status)
    }
    const limited = statuses.indexOf(429)
    // Concurrency: dev accounts get 3 active per seat. Hold 3, the 4th must be refused.
    const capWho = { sub: `w9-cap-${ctx.run.file.runId}` }
    const held: string[] = []
    let fourth: { status: number; reason?: string } = { status: 0 }
    try {
      for (let i = 0; i < 3; i++) {
        const r = await ctx.sandboxes.create(capWho, { workspaceId: `w9-cap-${i}` })
        if (r.status === 200) {
          held.push(r.body.sandbox.id)
        }
      }
      const r = await control.as(capWho, 'POST', '/v1/sandboxes', { workspaceId: 'w9-cap-3', machineSize: 'standard' })
      fourth = { status: r.status, reason: r.body?.reason }
      if (r.status === 200) {
        ctx.sandboxes.adopt(r.body.sandbox.id, capWho)
        ctx.run.created({ kind: 'sandbox', id: r.body.sandbox.id, label: 'w9-cap-3 (cap breach!)', vcpus: 4 })
        held.push(r.body.sandbox.id)
      }
    } finally {
      for (const id of held) {
        await ctx.sandboxes.destroy(id)
      }
    }
    const ok = limited === 10 && held.length === 3 && fourth.status === 403 && fourth.reason === 'concurrency_limit'
    return {
      status: ok ? 'pass' : 'fail',
      detail: `rate limit: first 429 at request #${limited + 1} (limit 10/min); concurrency: held ${held.length}, 4th -> ${fourth.status} ${fourth.reason ?? ''}`,
      evidence: [log('create statuses', statuses.join(','))]
    }
  },

  'ops.orphan-sweep': async (ctx) => {
    // A provider sandbox tagged as a dev Orca sandbox with no control-plane row is an orphan.
    const name = `orca-dev-sbx_w9orphan${ctx.run.file.runId.replace(/[^a-z0-9]/g, '')}`
    const api = vercel()
    const created = await api.createSandbox({
      name,
      snapshotId: GOLDEN(),
      vcpus: 2,
      region: 'iad1',
      timeoutMs: 10 * 60_000,
      ports: [],
      networkPolicy: { allow: {} },
      tags: { orcaEnv: 'dev', orcaSandbox: 'w9-orphan' },
      snapshotExpirationMs: 24 * 60 * 60_000
    })
    ctx.run.created({ kind: 'sandbox', id: name, label: 'orphan-sweep probe (no D1 row)', vcpus: 2 })
    try {
      const h = await control.operator('POST', '/v1/internal/housekeeping')
      const after = await api.getSandbox(name, { resume: false })
      const stopped = after ? ['stopped', 'stopping', 'snapshotting'].includes(after.session.status) || after.sandbox.status !== 'running' : true
      const ok = h.status === 200 && (h.body?.housekeeping?.orphanSandboxesSuspended ?? 0) >= 1 && stopped
      return {
        status: ok ? 'pass' : 'fail',
        detail: `housekeeping ${h.status}: suspended ${h.body?.housekeeping?.orphanSandboxesSuspended}, deleted ${h.body?.housekeeping?.orphanSandboxesDeleted}; probe sandbox ${created.sandbox.status} -> ${after?.session.status ?? 'gone'} (deleted after the grace period; the eval deletes it now)`,
        evidence: [log('housekeeping summary', JSON.stringify(h.body))]
      }
    } finally {
      await api.deleteSandbox(name)
      for (const snap of await api.listSnapshots(name)) {
        if (snap.status === 'created') {
          await api.deleteSnapshot(snap.id)
        }
      }
      ctx.run.destroyed('sandbox', name)
    }
  },

  'ops.cleanup': async (ctx) => {
    // Runs last: everything this run created must be gone at Vercel (sandboxes and snapshots).
    const { failed } = await ctx.sandboxes.destroyAll()
    const ours = ctx.run.file.resources.filter((r) => r.kind === 'sandbox').map((r) => (r.id.startsWith('orca-') ? r.id : `orca-dev-${r.id}`))
    const listing = await vercelRest('GET', '/v2/sandboxes', { project: config.vercelProjectId, limit: '100' })
    const live = (listing.json?.sandboxes ?? []).filter((s: any) => ours.includes(s.name)).map((s: any) => `${s.name}:${s.status}`)
    let snapshotsLeft = 0
    for (const name of ours) {
      snapshotsLeft += (await vercel().listSnapshots(name)).filter((s) => s.status === 'created').length
    }
    const ok = failed.length === 0 && live.length === 0 && snapshotsLeft === 0
    return {
      status: ok ? 'pass' : 'fail',
      detail: `${ours.length} sandboxes created by this run; still present at Vercel: ${live.length ? live.join(', ') : 'none'}; snapshots left: ${snapshotsLeft}; destroy failures: ${failed.length}`
    }
  }
}

function GOLDEN(): string {
  return process.env.ORCA_EVAL_GOLDEN_SNAPSHOT ?? 'snap_vpcmcCAgTtISiTZgsCosOlThQbFd'
}
