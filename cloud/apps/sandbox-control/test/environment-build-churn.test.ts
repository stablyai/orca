// ENV-BUILD-CHURN: goldens rotate per merge; rebuilding every environment on every rotation cost every
// team build hours. Eager refresh only for recently used environments, at most once per interval;
// the rest refresh when next used; a security golden reaches every environment, and no workspace
// boots from a build below the security floor. Refresh builds are never charged to the team.
import { describe, expect, it } from 'vitest'
import { lifecycleDeps, refreshEnvironmentsOnGolden, refreshOptions } from '../src/index'
import { GOLDEN, createHarness } from './harness'

const REPO = 'https://github.com/acme/web.git'
const RESULT = JSON.stringify({
  durationSec: 3,
  repos: [{ url: REPO, dir: 'acme/web', branch: 'main', commit: 'a'.repeat(40), lockfiles: {} }],
  diskUsedBytes: 3_000_000_000,
  diskTotalBytes: 34_000_000_000
})
const log = (data: string) => `${JSON.stringify({ data, stream: 'stdout' })}\n`
const DAY = 24 * 60 * 60_000

async function setup() {
  const pending: Promise<unknown>[] = []
  const h = await createHarness({}, { waitUntil: (work: Promise<unknown>) => void pending.push(work) })
  h.vercel.buildResult = RESULT
  const settle = async () => {
    while (pending.length > 0) {
      await Promise.all(pending.splice(0))
    }
  }
  // A fresh token per call: the tests move the clock by days.
  const call = async (method: string, path: string, body?: unknown) =>
    h.call(method, path, { bearer: await h.token('alice', 'acme', 'sandbox', { orgRole: 'admin' }), body })
  const created = await call('POST', '/v1/environments', {
    name: 'Default',
    repos: [{ url: 'acme/web', defaultBranch: 'main' }],
    installScript: 'pnpm install --frozen-lockfile'
  })
  const envId: string = created.body.environment.id
  /** Lets the newest build's VM command succeed and finalizes it. */
  async function finishNewest() {
    const command = [...h.vercel.buildCommands.values()].at(-1)!
    command.logs = log('::orca-step:: install\nok\n')
    command.exitCode = 0
    h.advance(1000)
    const newest = (await call('GET', `/v1/environments/${envId}/builds`)).body.builds[0]
    return (await call('GET', `/v1/environments/${envId}/builds/${newest.id}`)).body.build
  }
  async function build() {
    expect((await call('POST', `/v1/environments/${envId}/builds`)).status).toBe(200)
    return finishNewest()
  }
  /** The cron activates a new golden image, optionally a security one. */
  let goldens = 1
  function rotate(securityLevel = 0): string {
    goldens += 1
    const snap = `snap_golden_${goldens}`
    h.raw.prepare(`UPDATE golden_images SET status = 'retired' WHERE status = 'active'`).run()
    h.raw
      .prepare(
        `INSERT INTO golden_images (id, source, status, snapshot_id, created_at, updated_at, activated_at, security_level)
         VALUES (?, 'test', 'active', ?, ?, ?, ?, ?)`
      )
      .run(`g${goldens}`, snap, h.now(), h.now(), h.now(), securityLevel)
    return snap
  }
  const refresh = async () => refreshEnvironmentsOnGolden(h.env, (await lifecycleDeps(h.env, h.deps))!, h.deps)
  const setLastUsed = (at: number | null) =>
    h.raw.prepare('UPDATE environments SET last_used_at = ? WHERE id = ?').run(at, envId)
  const lastUsed = () =>
    (h.raw.prepare('SELECT last_used_at AS at FROM environments WHERE id = ?').get(envId) as { at: number | null }).at
  const create = async (workspaceId: string, features = 'environment-held') =>
    h.call('POST', '/v1/sandboxes', {
      bearer: await h.token('alice', 'acme', 'sandbox', { orgRole: 'admin' }),
      body: { workspaceId, machineSize: 'standard', repo: { url: REPO } },
      headers: { 'x-orca-sandbox-features': features }
    })
  return { h, call, envId, build, finishNewest, rotate, refresh, setLastUsed, lastUsed, create, settle }
}

describe('golden refresh churn (ENV-BUILD-CHURN)', () => {
  it('an environment idle for 30 days waits for a normal golden, and a security golden rebuilds it anyway', async () => {
    const { h, build, rotate, refresh, setLastUsed } = await setup()
    await build()
    setLastUsed(h.now() - 30 * DAY)
    h.advance(2 * DAY)
    rotate()
    expect(await refresh()).toMatchObject({ stale: 1, started: 0, deferred: 1 })
    const before = h.vercel.buildCommands.size
    rotate(1)
    expect(await refresh()).toMatchObject({ stale: 1, started: 1, deferred: 0 })
    expect(h.vercel.buildCommands.size).toBe(before + 1)
  })

  it('a recently used environment refreshes at most once per interval (24 h by default, configurable)', async () => {
    const { h, build, rotate, refresh, setLastUsed } = await setup()
    await build()
    setLastUsed(h.now())
    rotate()
    // Built a moment ago: deferred.
    expect(await refresh()).toMatchObject({ started: 0, deferred: 1 })
    h.advance(DAY + 60_000)
    expect(await refresh()).toMatchObject({ started: 1, deferred: 0 })
    // Configurable from the Worker's vars; 0 hours restores refresh on every golden.
    expect(refreshOptions({ ENV_REFRESH_MIN_INTERVAL_HOURS: '6', ENV_REFRESH_MAX_IN_FLIGHT: '10' })).toEqual({
      minIntervalMs: 6 * 60 * 60_000,
      maxInFlight: 10
    })
    expect(refreshOptions({ ENV_REFRESH_MIN_INTERVAL_HOURS: '0' })).toEqual({ minIntervalMs: 0 })
    expect(refreshOptions({ ENV_REFRESH_MIN_INTERVAL_HOURS: 'x', ENV_REFRESH_MAX_IN_FLIGHT: '-1' })).toEqual({})
  })

  it('an environment no create ever recorded counts as used (org environments from before tracking)', async () => {
    const { h, build, rotate, refresh, setLastUsed } = await setup()
    await build()
    setLastUsed(null)
    h.advance(DAY + 60_000)
    rotate()
    expect(await refresh()).toMatchObject({ started: 1 })
  })

  it('every boot records the use, org environments too, and an idle stale one refreshes when next used', async () => {
    const { h, build, rotate, refresh, setLastUsed, lastUsed, create, settle } = await setup()
    const active = await build()
    setLastUsed(h.now() - 30 * DAY)
    h.advance(2 * DAY)
    rotate()
    expect(await refresh()).toMatchObject({ started: 0, deferred: 1 })
    const before = h.vercel.buildCommands.size
    const ws = await create('w1')
    // Above the floor: boots its (older) build at once; the refresh runs behind the response.
    expect(ws.body.sandbox.environmentBuildId).toBe(active.id)
    expect(ws.body.environmentHeld).toBeUndefined()
    await settle()
    expect(lastUsed()).toBe(h.now())
    expect(h.vercel.buildCommands.size).toBe(before + 1)
  })

  it('a create below the security floor never boots that build, even while its rebuild runs, and starts exactly one rebuild', async () => {
    const { h, envId, build, rotate, create, settle } = await setup()
    const old = await build()
    const secure = rotate(1)
    const before = h.vercel.buildCommands.size
    const first = await create('w1')
    expect(first.status).toBe(200)
    expect(first.body.sandbox.environmentBuildId).toBeUndefined()
    expect(first.body.environmentHeld).toEqual({ environmentId: envId, reason: 'security_update' })
    const box = [...h.vercel.boxes.values()].find((b) => b.params.tags.orcaSandbox === first.body.sandbox.id)!
    expect(box.params.snapshotId).toBe(secure)
    await settle()
    expect(h.vercel.buildCommands.size).toBe(before + 1)
    // The rebuild is in flight: a second create still never selects the old snapshot, and starts nothing.
    const second = await create('w2')
    expect(second.body.sandbox.environmentBuildId).toBeUndefined()
    const secondBox = [...h.vercel.boxes.values()].find((b) => b.params.tags.orcaSandbox === second.body.sandbox.id)!
    const oldSnapshot = (h.raw.prepare('SELECT snapshot_id AS id FROM environment_builds WHERE id = ?').get(old.id) as { id: string }).id
    expect(box.params.snapshotId).not.toBe(oldSnapshot)
    expect(secondBox.params.snapshotId).not.toBe(oldSnapshot)
    expect(secondBox.params.snapshotId).toBe(secure)
    await settle()
    expect(h.vercel.buildCommands.size).toBe(before + 1)
    expect(GOLDEN).not.toBe(secure)
    // A desktop that doesn't know the field (strict parse) never gets it; it still never boots the old build.
    const older = await create('w3', 'clone-progress')
    expect(older.status).toBe(200)
    expect(older.body.environmentHeld).toBeUndefined()
    expect(older.body.sandbox.environmentBuildId).toBeUndefined()
  })

  it('refresh builds are metered internally, never charged to the team', async () => {
    const { h, build, rotate, refresh, finishNewest } = await setup()
    await build()
    h.env.ENV_REFRESH_MIN_INTERVAL_HOURS = '0'
    rotate()
    expect(await refresh()).toMatchObject({ started: 1 })
    const refreshed = await finishNewest()
    expect(refreshed.status).toBe('succeeded')
    expect(h.billing.usage.some((segment) => segment.usageId === `build:${refreshed.id}`)).toBe(false)
    // The admin's own build is charged as before.
    expect(h.billing.usage.some((segment) => segment.usageId.startsWith('build:'))).toBe(true)
  })
})
