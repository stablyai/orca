import { describe, expect, it } from 'vitest'
import {
  HostedArchiveResponseSchema,
  HostedSandboxReadyResponseSchema,
  HostedWakeResponseSchema,
  HostedWorkspaceStatusResponseSchema
} from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import { DRAIN_COMMAND, START_COMMAND } from '../src/sandbox-vm-commands'
import { ARCHIVE_SCRIPT, METRICS_SCRIPT } from '../src/sandbox-vm-inspect'
import { createHarness } from './harness'

const DAY = 86_400_000
const create = { workspaceId: 'ws-1', machineSize: 'standard' }

const metricsLine = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    cpuPercent: 12,
    cpus: 4,
    load1: 0.4,
    memTotalBytes: 8e9,
    memUsedBytes: 2e9,
    diskTotalBytes: 64e9,
    diskUsedBytes: 3e9,
    uptimeSeconds: 120,
    oomKills: 0,
    lastOomVictim: null,
    orcadAlive: true,
    ...over
  })

const checkout = {
  path: '/vercel/sandbox/project',
  branch: 'feature/x',
  head: 'a'.repeat(40),
  upstream: 'origin/feature/x',
  ahead: 2,
  behind: 0,
  commits: [{ sha: 'a'.repeat(40), author: 'Ada', at: 1_800_000_000_000, subject: 'Add x' }],
  changes: [{ status: 'M', path: 'src/x.ts' }],
  diffStat: '1 file changed, 2 insertions(+)',
  fileCount: 2,
  files: ['README.md', 'src/x.ts']
}

async function running() {
  const h = await createHarness()
  const created = HostedSandboxReadyResponseSchema.parse((await h.call('POST', '/v1/sandboxes', { body: create })).body)
  return { h, id: created.sandbox.id }
}

describe('wake', () => {
  it('answers ready with the endpoint for a running workspace, by sandbox or workspace id', async () => {
    const { h, id } = await running()
    const bySandbox = HostedWakeResponseSchema.parse((await h.call('POST', `/v1/sandboxes/${id}/wake`)).body)
    expect(bySandbox).toMatchObject({ state: 'ready', sandboxId: id })
    expect(bySandbox.endpoint).toMatch(/^wss:\/\/sb-\d+\.vercel\.run$/)
    expect(bySandbox.readyAt).toBe(h.now())
    // The public API route shares the wake and answers the same fields (plus `workspace`).
    const viaApi = (await h.call('POST', `/v1/workspaces/${id}/wake?wait=30s`)).body
    expect({ state: viaApi.state, endpoint: viaApi.endpoint, readyAt: viaApi.readyAt, sandboxId: viaApi.sandboxId }).toEqual(bySandbox)
  })

  it('wakes a sleeping workspace once however many callers race, and long-polls to ready', async () => {
    const { h, id } = await running()
    await h.call('POST', `/v1/sandboxes/${id}/suspend`)
    const starts = () => h.vercel.commands.filter((c) => c.command === START_COMMAND).length
    const before = starts()
    const answers = await Promise.all([
      h.call('POST', `/v1/sandboxes/${id}/wake?wait=30s`),
      h.call('POST', `/v1/sandboxes/${id}/wake?wait=30s`),
      h.call('POST', `/v1/sandboxes/${id}/wake`, { body: { wait: true } })
    ])
    expect(answers.map((a) => a.body.state)).toEqual(['ready', 'ready', 'ready'])
    expect(starts() - before).toBe(1)
  })

  it('returns waking immediately without a wait and finishes in the background', async () => {
    const background: Promise<unknown>[] = []
    const h = await createHarness({}, { waitUntil: (work) => void background.push(work) })
    const { body } = await h.call('POST', '/v1/sandboxes', { body: create })
    const id = body.sandbox.id
    await h.call("POST", `/v1/sandboxes/${id}/suspend`)
    const answer = HostedWakeResponseSchema.parse((await h.call('POST', `/v1/sandboxes/${id}/wake`)).body)
    // The fake provider is synchronous enough that the wake may already be done; either is valid.
    expect(['waking', 'ready']).toContain(answer.state)
    expect(background).toHaveLength(1)
    await Promise.all(background)
    expect((await h.call('POST', `/v1/sandboxes/${id}/wake`)).body.state).toBe('ready')
  })

  it('does not wake an archived workspace implicitly, and 404s an unknown workspace', async () => {
    const { h, id } = await running()
    await h.call('POST', `/v1/sandboxes/${id}/archive`, { body: {} })
    expect((await h.call('POST', `/v1/sandboxes/${id}/wake?wait=5s`)).body).toMatchObject({ state: 'archived', endpoint: null })
    expect((await h.call('POST', '/v1/sandboxes/sbx_nope/wake')).status).toBe(404)
  })

  it('refuses a wake billing denies', async () => {
    const { h, id } = await running()
    await h.call('POST', `/v1/sandboxes/${id}/suspend`)
    h.billing.decision = { allow: false, reason: 'included_hours_exhausted', suspendRunning: false }
    expect(await h.call('POST', `/v1/sandboxes/${id}/wake?wait=1s`)).toEqual({
      status: 403,
      body: { error: 'entitlement_denied', reason: 'included_hours_exhausted' }
    })
  })
})

describe('restart', () => {
  it('rehydrates a running workspace with a short drain and keeps the disk', async () => {
    const { h, id } = await running()
    const before = h.vercel.snapshots.size
    const ready = HostedSandboxReadyResponseSchema.parse((await h.call('POST', `/v1/sandboxes/${id}/restart`)).body)
    expect(ready.sandbox.status).toBe('running')
    expect(h.vercel.snapshots.size).toBe(before + 1)
    const drains = h.vercel.commands.filter((c) => c.command === DRAIN_COMMAND)
    expect(drains).toHaveLength(1)
  })

  it('recovers a wake that got stuck mid-way', async () => {
    const { h, id } = await running()
    h.raw.prepare(`UPDATE sandboxes SET status = 'resuming', updated_at = ? WHERE id = ?`).run(h.now(), id)
    h.advance(2 * 60_000)
    // A slow-but-alive wake is not taken over.
    expect((await h.call('POST', `/v1/sandboxes/${id}/restart`)).status).toBe(409)
    h.advance(4 * 60_000)
    const res = await h.call('POST', `/v1/sandboxes/${id}/restart`)
    expect(res.status).toBe(200)
    expect(res.body.sandbox.status).toBe('running')
  })
})

describe('status panel', () => {
  it('reports live metrics, uptime and cost so far', async () => {
    const { h, id } = await running()
    h.vercel.onScript = (script) => (script === METRICS_SCRIPT ? { exitCode: 0, stdout: `${metricsLine()}\n`, stderr: '' } : undefined)
    h.advance(90 * 60_000)
    const { status } = HostedWorkspaceStatusResponseSchema.parse((await h.call('GET', `/v1/sandboxes/${id}/status`)).body)
    expect(status.state).toBe('ready')
    expect(status.metrics?.memUsedBytes).toBe(2e9)
    expect(status.uptimeMs).toBe(90 * 60_000)
    expect(status.usage).toEqual({ totalMs: 90 * 60_000, centsPerHour: 75, costCents: 113 })
  })

  it('says unresponsive when the VM does not answer or orcad is dead, and surfaces OOM kills', async () => {
    const { h, id } = await running()
    h.vercel.onScript = () => ({ exitCode: 0, stdout: 'garbage', stderr: '' })
    expect((await h.call('GET', `/v1/sandboxes/${id}/status`)).body.status.state).toBe('unresponsive')
    h.vercel.onScript = () => ({ exitCode: 0, stdout: metricsLine({ orcadAlive: false, oomKills: 1, lastOomVictim: 'node' }), stderr: '' })
    const { status } = HostedWorkspaceStatusResponseSchema.parse((await h.call('GET', `/v1/sandboxes/${id}/status`)).body)
    expect(status.state).toBe('unresponsive')
    expect(status.metrics).toMatchObject({ oomKills: 1, lastOomVictim: 'node' })
  })

  it('counts settled sessions in the cost and does not probe a sleeping VM', async () => {
    const { h, id } = await running()
    h.advance(60 * 60_000)
    await h.call('POST', `/v1/sandboxes/${id}/suspend`)
    let probes = 0
    h.vercel.onScript = () => (probes++, undefined)
    const { status } = HostedWorkspaceStatusResponseSchema.parse((await h.call('GET', `/v1/sandboxes/${id}/status`)).body)
    expect(status).toMatchObject({ state: 'sleeping', metrics: null, uptimeMs: null, usage: { totalMs: 60 * 60_000, costCents: 75 } })
    expect(probes).toBe(0)
  })
})

describe('archive', () => {
  it('captures metadata in the VM, stops it, keeps the snapshot with a TTL, and unarchives the same disk', async () => {
    const { h, id } = await running()
    h.vercel.onScript = (script) =>
      script === ARCHIVE_SCRIPT ? { exitCode: 0, stdout: `${JSON.stringify({ checkouts: [checkout] })}\n`, stderr: '' } : undefined
    const pr = { number: 7, title: 'Add x', state: 'open', url: 'https://github.com/o/r/pull/7', branch: 'feature/x' }
    const archived = await h.call('POST', `/v1/sandboxes/${id}/archive`, { body: { pullRequests: [pr] } })
    // Callers that don't advertise `archive` (older strict desktops) see it as suspended.
    expect(archived.body.sandbox.status).toBe('suspended')
    const aware = await h.send(
      new Request(`https://sandbox.test/v1/sandboxes/${id}`, {
        headers: { authorization: `Bearer ${await h.token('alice')}`, 'x-orca-sandbox-features': 'archive' }
      })
    )
    expect(((await aware.json()) as any).sandbox.status).toBe('archived')
    const name = `orca-test-${id}`
    expect(h.vercel.boxes.get(name)!.status).toBe('stopped')
    expect(h.vercel.snapshotExpirations.get(name)).toBe(37 * DAY)

    const { archive } = HostedArchiveResponseSchema.parse((await h.call('GET', `/v1/sandboxes/${id}/archive`)).body)
    expect(archive).toMatchObject({ source: 'vm', metadata: { checkouts: [checkout], pullRequests: [pr] } })
    const status = HostedWorkspaceStatusResponseSchema.parse((await h.call('GET', `/v1/sandboxes/${id}/status`)).body).status
    expect(status.archive).toEqual({ archivedAt: h.now(), expiresAt: h.now() + 30 * DAY })

    const restored = HostedSandboxReadyResponseSchema.parse((await h.call('POST', `/v1/sandboxes/${id}/unarchive`)).body)
    expect(restored.sandbox.status).toBe('running')
    expect(h.vercel.snapshotExpirations.get(name)).toBe(104 * DAY)
    expect((await h.call('GET', `/v1/sandboxes/${id}/status`)).body.status.archive).toBeNull()
  })

  it('archives a sleeping workspace from the desktop cache without waking it', async () => {
    const { h, id } = await running()
    await h.call('POST', `/v1/sandboxes/${id}/suspend`)
    const starts = h.vercel.commands.filter((c) => c.command === START_COMMAND).length
    await h.call('POST', `/v1/sandboxes/${id}/archive`, { body: { checkouts: [checkout] } })
    expect(h.vercel.commands.filter((c) => c.command === START_COMMAND)).toHaveLength(starts)
    const { archive } = HostedArchiveResponseSchema.parse((await h.call('GET', `/v1/sandboxes/${id}/archive`)).body)
    expect(archive?.source).toBe('client')
  })

  it('rejects oversized archive bodies and destroys expired archives with their metadata', async () => {
    const { h, id } = await running()
    const tooMany = { checkouts: [{ ...checkout, files: Array.from({ length: 2001 }, (_, i) => `f${i}`) }] }
    expect((await h.call('POST', `/v1/sandboxes/${id}/archive`, { body: tooMany })).status).toBe(400)
    await h.call('POST', `/v1/sandboxes/${id}/archive`, { body: { checkouts: [checkout] } })
    h.advance(29 * DAY)
    expect((await h.reconcile()).archivesExpired).toBe(0)
    h.advance(2 * DAY)
    expect((await h.reconcile()).archivesExpired).toBe(1)
    expect(h.raw.prepare('SELECT status FROM sandboxes WHERE id = ?').get(id)).toEqual({ status: 'destroyed' })
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM sandbox_archives').get()).toEqual({ n: 0 })
    expect([...h.vercel.snapshots.values()].filter((s) => s.status !== 'deleted')).toHaveLength(0)
  })
})

describe('desktop client against the real handler', () => {
  it('drives wake, status, restart, archive and unarchive through the desktop client', async () => {
    const { createHostedSandboxControlPlaneClient } = await import(
      '../../../../src/main/hosted-sandbox/hosted-sandbox-control-plane-client'
    )
    const h = await createHarness()
    const client = createHostedSandboxControlPlaneClient({
      baseUrl: 'https://sandbox.test',
      getAccessToken: () => h.token('alice'),
      fetch: (input, init) => h.send(new Request(input as URL, init))
    })
    const created = await client.create({ workspaceId: 'ws-c', machineSize: 'standard' })
    const id = created.sandbox.id
    h.vercel.onScript = (script) =>
      script === METRICS_SCRIPT
        ? { exitCode: 0, stdout: metricsLine(), stderr: '' }
        : script === ARCHIVE_SCRIPT
          ? { exitCode: 0, stdout: JSON.stringify({ checkouts: [checkout] }), stderr: '' }
          : undefined
    expect((await client.wake(id, 30_000)).state).toBe('ready')
    expect((await client.workspaceStatus(id)).status.state).toBe('ready')
    expect((await client.restart(id)).sandbox.status).toBe('running')
    expect((await client.archive(id, {})).status).toBe('archived')
    expect((await client.archiveInfo(id))?.metadata.checkouts[0]?.branch).toBe('feature/x')
    expect((await client.wake(id, 0)).state).toBe('archived')
    expect((await client.unarchive(id)).sandbox.status).toBe('running')
  })
})

describe('wake recovery', () => {
  it('adopts a wake whose Worker was cut off: running VM gets orcad and an endpoint', async () => {
    const { h, id } = await running()
    await h.call('POST', `/v1/sandboxes/${id}/suspend`)
    // Simulate a wake that booted the VM, then lost its Worker before orcad/claim.
    await h.vercel.getSandbox(`orca-test-${id}`, { resume: true })
    h.raw.prepare(`UPDATE sandboxes SET status = 'resuming', updated_at = ? WHERE id = ?`).run(h.now(), id)
    expect((await h.call('POST', `/v1/sandboxes/${id}/wake`)).body.state).toBe('waking')
    // A live inline boot can take minutes: not adopted yet.
    h.advance(3 * 60_000)
    expect((await h.call('POST', `/v1/sandboxes/${id}/wake`)).body.state).toBe('waking')
    h.advance(61_000)
    const answer = HostedWakeResponseSchema.parse((await h.call('POST', `/v1/sandboxes/${id}/wake`)).body)
    expect(answer.state).toBe('ready')
    expect(answer.endpoint).toMatch(/^wss:/)
  })

  it('a stale wake whose VM never came up goes back to sleep and wakes again', async () => {
    const { h, id } = await running()
    await h.call('POST', `/v1/sandboxes/${id}/suspend`)
    h.raw.prepare(`UPDATE sandboxes SET status = 'resuming', updated_at = ? WHERE id = ?`).run(h.now(), id)
    h.advance(4 * 60_000 + 1000)
    expect((await h.call('POST', `/v1/sandboxes/${id}/wake?wait=30s`)).body.state).toBe('ready')
  })

  it('answers failed after a failed wake instead of booting on every poll', async () => {
    const { h, id } = await running()
    await h.call('POST', `/v1/sandboxes/${id}/suspend`)
    h.vercel.failStart = true
    expect((await h.call('POST', `/v1/sandboxes/${id}/wake?wait=30s`)).body.state).toBe('failed')
    const starts = h.vercel.commands.filter((c) => c.command === START_COMMAND).length
    expect((await h.call('POST', `/v1/sandboxes/${id}/wake?wait=30s`)).body.state).toBe('failed')
    expect(h.vercel.commands.filter((c) => c.command === START_COMMAND)).toHaveLength(starts)
    h.vercel.failStart = false
    h.advance(61_000)
    expect((await h.call('POST', `/v1/sandboxes/${id}/wake?wait=30s`)).body.state).toBe('ready')
  })

  it('reports a provider-stopped VM as sleeping, not unresponsive', async () => {
    const { h, id } = await running()
    h.vercel.expire(`orca-test-${id}`)
    h.advance(31 * 60_000)
    expect((await h.call('GET', `/v1/sandboxes/${id}/status`)).body.status.state).toBe('sleeping')
  })
})

describe('adopted wakes boot like real wakes', () => {
  it('starts orcad with the session secrets and the egress policy, and keeps metering intact', async () => {
    const h = await createHarness({ SECRETS_KEK: Buffer.alloc(32, 7).toString('base64') })
    expect((await h.call('PUT', '/v1/secrets/personal/OPENAI_API_KEY', { body: { value: 'sk-adopted-test' } })).status).toBe(200)
    const created = HostedSandboxReadyResponseSchema.parse((await h.call('POST', '/v1/sandboxes', { body: create })).body)
    const id = created.sandbox.id
    await h.call('POST', `/v1/sandboxes/${id}/suspend`)
    await h.vercel.getSandbox(`orca-test-${id}`, { resume: true })
    h.raw.prepare(`UPDATE sandboxes SET status = 'resuming', updated_at = ? WHERE id = ?`).run(h.now(), id)
    const before = h.vercel.commands.length
    h.advance(4 * 60_000 + 1000)
    expect((await h.call('POST', `/v1/sandboxes/${id}/wake`)).body.state).toBe('ready')
    const start = h.vercel.commands.slice(before).find((c) => c.command === START_COMMAND)!
    expect(start.env.ORCA_SECRET_ENV).toContain('OPENAI_API_KEY=')
    expect(start.env.ORCA_PUBLIC_WSS).toMatch(/^wss:/)
    const row = h.raw.prepare('SELECT status, session_id, orcad_endpoint FROM sandboxes WHERE id = ?').get(id) as any
    expect(row.status).toBe('running')
    expect(row.orcad_endpoint).toMatch(/^wss:/)
  })

  it('a cron-repaired running row without orcad gets a full boot and keeps its usage cursor', async () => {
    const { h, id } = await running()
    h.advance(10 * 60_000)
    const cursor = (h.raw.prepare('SELECT usage_settled_at FROM sandboxes WHERE id = ?').get(id) as any).usage_settled_at
    h.raw.prepare('UPDATE sandboxes SET orcad_endpoint = NULL WHERE id = ?').run(id)
    const before = h.vercel.commands.filter((c) => c.command === START_COMMAND).length
    expect((await h.call('POST', `/v1/sandboxes/${id}/wake`)).body.state).toBe('ready')
    expect(h.vercel.commands.filter((c) => c.command === START_COMMAND)).toHaveLength(before + 1)
    expect((h.raw.prepare('SELECT usage_settled_at FROM sandboxes WHERE id = ?').get(id) as any).usage_settled_at).toBe(cursor)
  })
})

describe('idle sleep minutes', () => {
  it('reports one idle-sleep value, equal to the billing plan, overridable by IDLE_SLEEP_MINUTES, only to clients that ask', async () => {
    const { DEFAULT_PLANS } = await import('../../billing/src/plans')
    const { DEFAULT_IDLE_SLEEP_MINUTES } = await import('../src/workspace-lifecycle')
    expect(DEFAULT_IDLE_SLEEP_MINUTES).toBe(DEFAULT_PLANS.team.idleSleepMinutes)
    const statusOf = async (h: Awaited<ReturnType<typeof createHarness>>, id: string, features?: string) => {
      const response = await h.send(
        new Request(`https://sandbox.test/v1/sandboxes/${id}/status`, {
          headers: {
            authorization: `Bearer ${await h.token('alice')}`,
            ...(features ? { 'x-orca-sandbox-features': features } : {})
          }
        })
      )
      return ((await response.json()) as any).status
    }
    const { h, id } = await running()
    // Older strict desktops never see the new field.
    expect((await statusOf(h, id)).idleSleepMinutes).toBeUndefined()
    const status = HostedWorkspaceStatusResponseSchema.parse({ sandbox: (await h.call('GET', `/v1/sandboxes/${id}`)).body.sandbox, status: await statusOf(h, id, 'archive,idle-minutes') }).status
    expect(status.idleSleepMinutes).toBe(15)
    const custom = await createHarness({ IDLE_SLEEP_MINUTES: '7' })
    const made = (await custom.call('POST', '/v1/sandboxes', { body: create })).body
    expect((await statusOf(custom, made.sandbox.id, 'idle-minutes')).idleSleepMinutes).toBe(7)
  })
})

describe('wake hints', () => {
  const statusOf = async (h: Awaited<ReturnType<typeof createHarness>>, id: string, features?: string) => {
    const response = await h.send(
      new Request(`https://sandbox.test/v1/sandboxes/${id}/status`, {
        headers: {
          authorization: `Bearer ${await h.token('alice')}`,
          ...(features ? { 'x-orca-sandbox-features': features } : {})
        }
      })
    )
    return ((await response.json()) as any).status
  }

  it('records a chosen sleep (no body: CLI, phone, older desktops) but not the idle timer, and counts running sandboxes for the seat', async () => {
    const { h, id } = await running()
    // Only clients that ask see the hints.
    expect((await statusOf(h, id)).running).toBeUndefined()
    const awake = HostedWorkspaceStatusResponseSchema.parse({
      sandbox: (await h.call('GET', `/v1/sandboxes/${id}`)).body.sandbox,
      status: await statusOf(h, id, 'archive,idle-minutes,wake-hints')
    }).status
    expect(awake).toMatchObject({ lastUserSleepAt: null, running: { owner: 1, account: 1 } })

    expect((await h.call('POST', `/v1/sandboxes/${id}/suspend`, { body: { reason: 'idle' } })).status).toBe(200)
    const idle = await statusOf(h, id, 'wake-hints')
    expect(idle).toMatchObject({ state: 'sleeping', lastUserSleepAt: null, running: { owner: 0, account: 0 } })

    await h.call('POST', `/v1/sandboxes/${id}/resume`)
    h.advance(60_000)
    const sleptAt = h.now()
    expect((await h.call('POST', `/v1/sandboxes/${id}/suspend`)).status).toBe(200)
    expect((await statusOf(h, id, 'wake-hints')).lastUserSleepAt).toBe(sleptAt)
  })
})
