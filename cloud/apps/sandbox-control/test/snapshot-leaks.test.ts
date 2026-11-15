// Every delete path frees its snapshots, and nothing ever deletes a snapshot something live still
// boots from (snapshot-refs.ts): retired golden images, deleted environments' builds, team delete,
// the orphan sweeps, a provider delete that failed once.
import { describe, expect, it } from 'vitest'
import { DEFAULT_RETENTION, housekeeping } from '../src/retention'
import type { LifecycleDeps } from '../src/lifecycle'
import { snapshotsInUse } from '../src/snapshot-refs'
import { purgeTeamSecrets } from '../src/team-delete'
import { ProviderError } from '../src/sandbox-provider'
import { GOLDEN, createHarness } from './harness'

const HOUR = 60 * 60_000
const create = (workspaceId: string) => ({ body: { workspaceId, machineSize: 'standard' } })

async function setup() {
  const h = await createHarness()
  const deps: LifecycleDeps = {
    db: h.env.SANDBOX_DB,
    provider: h.vercel,
    entitlements: {
      checkStart: async () => h.billing.decision,
      reportUsage: async () => h.billing.usageAnswer,
      listSuspensions: async () => h.billing.suspensions
    },
    now: h.now,
    retention: DEFAULT_RETENTION,
    config: { environment: 'test', goldenSnapshotId: GOLDEN, defaultRegion: 'iad1' }
  }
  const sweep = () => housekeeping(deps, { force: true, notifier: { warn: async () => undefined } })
  const snap = (id: string, creationMethod = 'manual', sandboxName = 'build') =>
    h.vercel.snapshots.set(id, { id, status: 'created', sourceSessionId: 's', sandboxName, creationMethod, createdAt: h.now() })
  const status = (id: string) => h.vercel.snapshots.get(id)?.status
  return { h, deps, sweep, snap, status }
}

function golden(h: Awaited<ReturnType<typeof createHarness>>, id: string, status: string, snapshotId: string, createdAt: number) {
  h.raw
    .prepare(`INSERT INTO golden_images (id, source, status, snapshot_id, created_at, updated_at, region) VALUES (?, 'seed', ?, ?, ?, ?, 'iad1')`)
    .run(id, status, snapshotId, createdAt, createdAt)
}

function environment(h: Awaited<ReturnType<typeof createHarness>>, id: string, accountId: string, builds: { id: string; snapshotId: string }[]) {
  h.raw
    .prepare(
      `INSERT INTO environments (id, account_id, name, repos, install_script, env_var_names, machine_size, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, '[]', '', '[]', 'standard', 'u', 'u', 1, 1)`
    )
    .run(id, accountId, id)
  builds.forEach((build, i) =>
    h.raw
      .prepare(
        `INSERT INTO environment_builds (id, environment_id, account_id, number, status, config, base_snapshot_id, provider_name, snapshot_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'succeeded', '{}', ?, ?, ?, 'u', 1, 1)`
      )
      .run(build.id, id, accountId, i + 1, GOLDEN, `orca-test-envbuild-${build.id}`, build.snapshotId)
  )
  h.raw.prepare('UPDATE environments SET active_build_id = ? WHERE id = ?').run(builds.at(-1)?.id ?? null, id)
}

describe('workspace delete', () => {
  it('deletes every automatic snapshot the workspace made, never the golden it booted from', async () => {
    const { h, status } = await setup()
    const id = (await h.call('POST', '/v1/sandboxes', create('ws-1'))).body.sandbox.id
    await h.call('POST', `/v1/sandboxes/${id}/suspend`)
    await h.call('POST', `/v1/sandboxes/${id}/resume`)
    await h.call('POST', `/v1/sandboxes/${id}/suspend`)
    const own = [...h.vercel.snapshots.values()].filter((s) => s.sandboxName === `orca-test-${id}`)
    expect(own.length).toBe(2)
    expect((await h.call('DELETE', `/v1/sandboxes/${id}`)).status).toBe(200)
    expect(own.map((s) => status(s.id))).toEqual(['deleted', 'deleted'])
    expect(h.vercel.boxes.size).toBe(0)
  })
})

describe('snapshotsInUse', () => {
  it('pins goldens, pool images, active environment builds, live workspaces’ own snapshots and un-stopped boot images', async () => {
    const { h, deps } = await setup()
    golden(h, 'g_active', 'active', 'snap_g_active', 3)
    golden(h, 'g_failed', 'failed', 'snap_g_failed', 2)
    environment(h, 'env_a', 'org:acme', [{ id: 'b1', snapshotId: 'snap_b1' }, { id: 'b2', snapshotId: 'snap_b2' }])
    h.raw
      .prepare(`INSERT INTO sandbox_pool (id, provider_name, machine_size, region, snapshot_id, status, created_at, updated_at) VALUES ('p1', 'orca-test-p1', 'standard', 'iad1', 'snap_pool', 'ready', 1, 1)`)
      .run()
    const id = (await h.call('POST', '/v1/sandboxes', create('ws-1'))).body.sandbox.id
    h.raw.prepare('UPDATE sandboxes SET source_snapshot_id = ? WHERE id = ?').run('snap_boot', id)
    const ids = [GOLDEN, 'snap_g_active', 'snap_g_failed', 'snap_b1', 'snap_b2', 'snap_pool', 'snap_boot', 'snap_free']
    expect([...(await snapshotsInUse(deps.db, deps.config, ids))].sort()).toEqual(
      [GOLDEN, 'snap_b2', 'snap_boot', 'snap_g_active', 'snap_pool'].sort()
    )
    // Once the workspace stopped once it resumes from its own snapshot: the boot image is free, its own one is pinned.
    await h.call('POST', `/v1/sandboxes/${id}/suspend`)
    const own = [...h.vercel.snapshots.values()].find((s) => s.sandboxName === `orca-test-${id}`)!.id
    const after = await snapshotsInUse(deps.db, deps.config, ['snap_boot', own])
    expect(after.has('snap_boot')).toBe(false)
    expect(after.has(own)).toBe(true)
    // A destroyed workspace pins nothing.
    await h.call('DELETE', `/v1/sandboxes/${id}`)
    expect((await snapshotsInUse(deps.db, deps.config, [own])).size).toBe(0)
  })
})

describe('golden rotation', () => {
  it('keeps one retired rollback, defers one a live workspace still boots from, retries a failed delete', async () => {
    const { h, sweep, snap, status } = await setup()
    golden(h, 'g4', 'active', 'snap_g4', 4)
    golden(h, 'g3', 'retired', 'snap_g3', 3)
    golden(h, 'g2', 'retired', 'snap_g2', 2)
    golden(h, 'g1', 'retired', 'snap_g1', 1)
    for (const id of ['snap_g4', 'snap_g3', 'snap_g2', 'snap_g1']) {
      snap(id)
    }
    const ws = (await h.call('POST', '/v1/sandboxes', create('ws-1'))).body.sandbox.id
    h.raw.prepare('UPDATE sandboxes SET source_snapshot_id = ? WHERE id = ?').run('snap_g2', ws)
    const deleteSnapshot = h.vercel.deleteSnapshot
    let failures = 1
    h.vercel.deleteSnapshot = async (id) => {
      if (id === 'snap_g1' && failures-- > 0) {
        throw new ProviderError(503, null)
      }
      return deleteSnapshot(id)
    }
    const goldenStatus = (id: string) => (h.raw.prepare('SELECT status FROM golden_images WHERE id = ?').get(id) as { status: string }).status

    expect((await sweep()).releasedSnapshotsKept).toBe(2)
    expect([status('snap_g1'), goldenStatus('g1')]).toEqual(['created', 'retired'])
    expect([status('snap_g2'), goldenStatus('g2')]).toEqual(['created', 'retired'])

    const second = await sweep()
    expect([second.releasedSnapshotsDeleted, second.releasedSnapshotsKept]).toEqual([1, 1])
    expect([status('snap_g1'), goldenStatus('g1')]).toEqual(['deleted', 'deleted'])
    expect(status('snap_g2')).toBe('created')

    // The workspace stops once (now it has its own snapshot): its boot image is released.
    await h.call('POST', `/v1/sandboxes/${ws}/suspend`)
    expect((await sweep()).releasedSnapshotsDeleted).toBe(1)
    expect([status('snap_g2'), goldenStatus('g2')]).toEqual(['deleted', 'deleted'])
    // The newest retired (rollback) and the active image are never touched.
    expect([status('snap_g3'), status('snap_g4')]).toEqual(['created', 'created'])
    expect((await h.call('POST', `/v1/sandboxes/${ws}/resume`)).status).toBe(200)
  })
})

describe('deleted environments and teams', () => {
  it('a team delete marks its environments deleted; housekeeping frees their build snapshots unless a live workspace boots from one', async () => {
    const { h, sweep, snap, status } = await setup()
    environment(h, 'env_team', 'org:gone', [{ id: 'tb1', snapshotId: 'snap_tb1' }, { id: 'tb2', snapshotId: 'snap_tb2' }])
    environment(h, 'env_other', 'org:stays', [{ id: 'ob1', snapshotId: 'snap_ob1' }])
    for (const id of ['snap_tb1', 'snap_tb2', 'snap_ob1']) {
      snap(id)
    }
    // Another account's live workspace was created from tb1 (it never stopped yet).
    const ws = (await h.call('POST', '/v1/sandboxes', create('ws-1'))).body.sandbox.id
    h.raw.prepare('UPDATE sandboxes SET source_snapshot_id = ? WHERE id = ?').run('snap_tb1', ws)

    expect(await purgeTeamSecrets(h.env.SANDBOX_DB, 'org:gone', h.now())).toEqual({ ok: true, purged: 0 })
    expect(h.raw.prepare('SELECT deleted_at IS NOT NULL AS d, active_build_id FROM environments WHERE id = ?').get('env_team')).toEqual({ d: 1, active_build_id: null })

    const first = await sweep()
    expect([first.releasedSnapshotsDeleted, first.releasedSnapshotsKept]).toEqual([1, 1])
    expect([status('snap_tb1'), status('snap_tb2'), status('snap_ob1')]).toEqual(['created', 'deleted', 'created'])

    await h.call('DELETE', `/v1/sandboxes/${ws}`)
    expect((await sweep()).releasedSnapshotsDeleted).toBe(1)
    expect(status('snap_tb1')).toBe('deleted')
    const marked = h.raw.prepare(`SELECT id FROM environment_builds WHERE snapshot_deleted_at IS NOT NULL ORDER BY id`).all()
    expect(marked).toEqual([{ id: 'tb1' }, { id: 'tb2' }])
  })

  it('an admin delete whose provider call fails keeps the build for the next sweep instead of marking it gone', async () => {
    const { h, deps, sweep, snap, status } = await setup()
    environment(h, 'env_a', 'org:acme', [{ id: 'b1', snapshotId: 'snap_b1' }])
    snap('snap_b1')
    const deleteSnapshot = h.vercel.deleteSnapshot
    h.vercel.deleteSnapshot = async () => {
      throw new ProviderError(500, null)
    }
    const { deleteEnvironmentAndSnapshots } = await import('../src/auto-environments')
    await deleteEnvironmentAndSnapshots(deps, 'env_a')
    expect(h.raw.prepare('SELECT snapshot_deleted_at FROM environment_builds WHERE id = ?').get('b1')).toEqual({ snapshot_deleted_at: null })
    h.vercel.deleteSnapshot = deleteSnapshot
    expect((await sweep()).releasedSnapshotsDeleted).toBe(1)
    expect(status('snap_b1')).toBe('deleted')
  })
})

describe('orphan snapshot sweep', () => {
  it('never deletes an automatic snapshot a warm-pool VM or a live workspace boots from', async () => {
    const { h, sweep, snap, status } = await setup()
    snap('snap_pool_image', 'automatic', 'orca-test-long-gone-a')
    snap('snap_boot_image', 'automatic', 'orca-test-long-gone-b')
    snap('snap_free', 'automatic', 'orca-test-long-gone-c')
    h.raw
      .prepare(`INSERT INTO sandbox_pool (id, provider_name, machine_size, region, snapshot_id, status, created_at, updated_at) VALUES ('p1', 'orca-test-p1', 'standard', 'iad1', 'snap_pool_image', 'warming', 1, 1)`)
      .run()
    const ws = (await h.call('POST', '/v1/sandboxes', create('ws-1'))).body.sandbox.id
    h.raw.prepare('UPDATE sandboxes SET source_snapshot_id = ? WHERE id = ?').run('snap_boot_image', ws)
    await sweep()
    h.advance(25 * HOUR)
    expect((await sweep()).orphanSnapshotsDeleted).toBe(1)
    expect([status('snap_pool_image'), status('snap_boot_image'), status('snap_free')]).toEqual(['created', 'created', 'deleted'])
  })
})
