import { describe, expect, it } from 'vitest'
import { DEFAULT_RETENTION, housekeeping, type RetentionWarning } from '../src/retention'
import type { LifecycleDeps } from '../src/lifecycle'
import { GOLDEN, createHarness } from './harness'

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const create = (workspaceId: string) => ({ body: { workspaceId, machineSize: 'standard' } })

async function setup() {
  const h = await createHarness()
  const warnings: RetentionWarning[] = []
  const deps: LifecycleDeps = {
    db: h.env.SANDBOX_DB,
    provider: h.vercel,
    entitlements: {
      checkStart: async (request) => {
        h.billing.checks.push({ accountId: request.accountId, runningSandboxes: request.runningSandboxes })
        return h.billing.decision
      },
      reportUsage: async () => h.billing.usageAnswer,
      listSuspensions: async () => h.billing.suspensions
    },
    now: h.now,
    retention: DEFAULT_RETENTION,
    config: { environment: 'test', goldenSnapshotId: GOLDEN, defaultRegion: 'iad1' }
  }
  const sweep = () => housekeeping(deps, { force: true, notifier: { warn: async (w) => void warnings.push(w) } })
  return { h, deps, warnings, sweep }
}

describe('orphan sweep', () => {
  it('never stops a warm-pool VM: its record is the pool row, not a sandboxes row', async () => {
    const { h, deps, sweep } = await setup()
    const name = 'orca-test-sbx_pooled'
    await h.vercel.createSandbox({
      name,
      snapshotId: GOLDEN,
      vcpus: 4,
      region: 'iad1',
      timeoutMs: 30 * 60_000,
      ports: [],
      networkPolicy: { allow: {} },
      tags: { orcaSandbox: 'sbx_pooled', orcaEnv: 'test', orcaPool: '1' },
      snapshotExpirationMs: 0
    })
    await deps.db
      .prepare(
        `INSERT INTO sandbox_pool (id, provider_name, machine_size, region, snapshot_id, status, created_at, updated_at) VALUES ('sbx_pooled', ?, 'standard', 'iad1', ?, 'ready', 1, 1)`
      )
      .bind(name, GOLDEN)
      .run()
    expect((await sweep()).orphanSandboxesSuspended).toBe(0)
    expect(h.vercel.boxes.get(name)!.status).toBe('running')
  })

  it('suspends a provider sandbox with no live D1 row, deletes it after the grace period, leaves tracked ones alone', async () => {
    const { h, sweep } = await setup()
    const tracked = await h.call('POST', '/v1/sandboxes', create('ws-1'))
    await h.vercel.createSandbox({
      name: 'orca-test-sbx_ghost',
      snapshotId: GOLDEN,
      vcpus: 4,
      region: 'iad1',
      timeoutMs: 30 * 60_000,
      ports: [],
      networkPolicy: { allow: {} },
      tags: { orcaSandbox: 'sbx_ghost', orcaEnv: 'test' },
      snapshotExpirationMs: 0
    })
    // Another environment's sandbox is never judged by this one.
    await h.vercel.createSandbox({
      name: 'orca-prod-sbx_other',
      snapshotId: GOLDEN,
      vcpus: 4,
      region: 'iad1',
      timeoutMs: 30 * 60_000,
      ports: [],
      networkPolicy: { allow: {} },
      tags: { orcaSandbox: 'sbx_other', orcaEnv: 'prod' },
      snapshotExpirationMs: 0
    })
    const first = await sweep()
    expect(first).toMatchObject({ orphanSandboxesSuspended: 1, orphanSandboxesDeleted: 0 })
    expect(h.vercel.boxes.get('orca-test-sbx_ghost')!.status).toBe('stopped')
    expect(h.vercel.boxes.get('orca-prod-sbx_other')!.status).toBe('running')
    expect(h.vercel.boxes.get(`orca-test-${tracked.body.sandbox.id}`)!.status).toBe('running')

    h.advance(23 * HOUR)
    expect((await sweep()).orphanSandboxesDeleted).toBe(0)
    h.advance(2 * HOUR)
    expect((await sweep()).orphanSandboxesDeleted).toBe(1)
    expect(h.vercel.boxes.has('orca-test-sbx_ghost')).toBe(false)
    const ghostSnaps = [...h.vercel.snapshots.values()].filter((s) => s.sandboxName === 'orca-test-sbx_ghost')
    expect(ghostSnaps.every((s) => s.status === 'deleted')).toBe(true)
    expect(h.vercel.boxes.has('orca-prod-sbx_other')).toBe(true)
    expect(h.vercel.boxes.has(`orca-test-${tracked.body.sandbox.id}`)).toBe(true)
  })

  it('deletes automatic snapshots whose sandbox is gone after the grace period, never manual or owned ones', async () => {
    const { h, sweep } = await setup()
    const tracked = await h.call('POST', '/v1/sandboxes', create('ws-1'))
    await h.call('POST', `/v1/sandboxes/${tracked.body.sandbox.id}/suspend`)
    const add = (id: string, creationMethod: string, sandboxName: string) =>
      h.vercel.snapshots.set(id, { id, status: 'created', sourceSessionId: 's', sandboxName, creationMethod, createdAt: h.now() })
    add('snap_leftover', 'automatic', 'orca-test-sbx_deleted_long_ago')
    add('snap_old_golden', 'manual', 'golden-build')
    const owned = [...h.vercel.snapshots.values()].find((s) => s.sandboxName === `orca-test-${tracked.body.sandbox.id}`)!

    expect((await sweep()).orphanSnapshotsSeen).toBe(1)
    h.advance(25 * HOUR)
    expect((await sweep()).orphanSnapshotsDeleted).toBe(1)
    expect(h.vercel.snapshots.get('snap_leftover')!.status).toBe('deleted')
    expect(h.vercel.snapshots.get('snap_old_golden')!.status).toBe('created')
    expect(h.vercel.snapshots.get(owned.id)!.status).toBe('created')
    expect((await h.call('POST', `/v1/sandboxes/${tracked.body.sandbox.id}/resume`)).status).toBe(200)
  })

  it('a partial provider listing deletes nothing', async () => {
    const { h, sweep } = await setup()
    h.vercel.snapshots.set('snap_leftover', { id: 'snap_leftover', status: 'created', sourceSessionId: 's', sandboxName: 'gone', creationMethod: 'automatic', createdAt: 0 })
    const list = h.vercel.listSandboxes
    h.vercel.listSandboxes = async () => ({ ...(await list()), complete: false })
    await sweep()
    h.advance(48 * HOUR)
    expect((await sweep()).orphanSnapshotsDeleted).toBe(0)
    expect(h.vercel.snapshots.get('snap_leftover')!.status).toBe('created')
  })
})

describe('data retention', () => {
  it('destroys a canceled account’s sandboxes 30 days after cancel, warning 7 days ahead', async () => {
    const { h, sweep, warnings } = await setup()
    const box = await h.call('POST', '/v1/sandboxes', create('ws-1'))
    h.billing.suspensions = ['user:alice']
    h.billing.decision = { allow: false, reason: 'payment_grace_expired', suspendRunning: true }
    await h.reconcile()
    expect(h.raw.prepare('SELECT reason FROM account_holds WHERE account_id = ?').get('user:alice')).toEqual({ reason: 'payment_grace_expired' })
    expect((await h.call('GET', `/v1/sandboxes/${box.body.sandbox.id}`)).body.sandbox.status).toBe('suspended')

    h.advance(22 * DAY)
    expect((await sweep()).retentionWarnings).toBe(0)
    h.advance(1 * DAY)
    expect((await sweep()).retentionWarnings).toBe(1)
    expect(warnings[0]).toMatchObject({ kind: 'data_deletion', accountId: 'user:alice', sandboxIds: [box.body.sandbox.id] })
    h.advance(6 * DAY)
    expect((await sweep()).retentionDestroyed).toBe(0)
    h.advance(1 * DAY + HOUR)
    expect((await sweep()).retentionDestroyed).toBe(1)
    expect(h.vercel.boxes.size).toBe(0)
    expect([...h.vercel.snapshots.values()].every((s) => s.status === 'deleted')).toBe(true)
    expect(h.raw.prepare('SELECT repo_url, status FROM sandboxes').get()).toEqual({ repo_url: null, status: 'destroyed' })
  })

  it('a canceled subscription found by the standing probe starts the clock; resubscribing clears it', async () => {
    const { h, sweep } = await setup()
    await h.call('POST', '/v1/sandboxes', create('ws-1'))
    h.billing.decision = { allow: false, reason: 'subscription_inactive', suspendRunning: false }
    expect((await sweep()).holdsOpened).toBe(1)
    h.advance(2 * DAY)
    h.billing.decision = { allow: true, reason: null, suspendRunning: false }
    expect((await sweep()).holdsCleared).toBe(1)
    h.advance(40 * DAY)
    expect((await sweep()).retentionDestroyed).toBe(0)
    expect(h.vercel.boxes.size).toBe(1)
  })

  it('an exhausted-hours denial or a billing outage never starts a deletion clock', async () => {
    const { h, sweep, deps } = await setup()
    await h.call('POST', '/v1/sandboxes', create('ws-1'))
    h.billing.decision = { allow: false, reason: 'included_hours_exhausted', suspendRunning: false }
    expect((await sweep()).holdsOpened).toBe(0)
    deps.entitlements.checkStart = async () => {
      throw new Error('billing down')
    }
    h.advance(2 * DAY)
    expect((await sweep()).holdsOpened).toBe(0)
    expect(h.raw.prepare(`SELECT COUNT(*) AS n FROM account_holds WHERE reason <> 'active'`).get()).toEqual({ n: 0 })
  })

  it('idle retention: a suspended sandbox untouched 90 days is warned at 83 and destroyed at 90; a resume resets it', async () => {
    const { h, sweep, warnings } = await setup()
    const idle = await h.call('POST', '/v1/sandboxes', create('ws-idle'))
    const used = await h.call('POST', '/v1/sandboxes', create('ws-used'))
    await h.call('POST', `/v1/sandboxes/${idle.body.sandbox.id}/suspend`)
    await h.call('POST', `/v1/sandboxes/${used.body.sandbox.id}/suspend`)
    h.advance(84 * DAY)
    expect((await sweep()).idleWarnings).toBe(2)
    expect(warnings.map((w) => w.kind)).toEqual(['idle_deletion', 'idle_deletion'])
    await h.call('POST', `/v1/sandboxes/${used.body.sandbox.id}/resume`)
    await h.call('POST', `/v1/sandboxes/${used.body.sandbox.id}/suspend`)
    h.advance(7 * DAY)
    expect((await sweep()).idleDestroyed).toBe(1)
    expect((await h.call('GET', `/v1/sandboxes/${idle.body.sandbox.id}`)).status).toBe(200)
    expect((await h.call('GET', `/v1/sandboxes/${idle.body.sandbox.id}`)).body.sandbox.status).toBe('destroyed')
    expect((await h.call('GET', `/v1/sandboxes/${used.body.sandbox.id}`)).body.sandbox.status).toBe('suspended')
  })

  it('new sandboxes ask the provider for a snapshot expiry beyond idle retention', async () => {
    const { h } = await setup()
    await h.call('POST', '/v1/sandboxes', create('ws-1'))
    expect([...h.vercel.boxes.values()][0]!.params.snapshotExpirationMs).toBe(104 * DAY)
  })
})
