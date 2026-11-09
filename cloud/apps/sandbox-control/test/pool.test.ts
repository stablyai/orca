import { describe, expect, it } from 'vitest'
import { HostedSandboxReadyResponseSchema } from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import { maintainPool, poolConfigFromEnv, type PoolDeps } from '../src/pool'
import { START_COMMAND } from '../src/sandbox-vm-commands'
import { GOLDEN, createHarness } from './harness'

const MIN = 60_000
const create = { workspaceId: 'ws-1', machineSize: 'standard' }

async function pooledHarness(size = '2') {
  const h = await createHarness({ SANDBOX_POOL_SIZE: size })
  const deps = (golden = GOLDEN): PoolDeps => ({
    db: h.env.SANDBOX_DB,
    provider: h.vercel,
    now: h.now,
    config: { environment: 'test', goldenSnapshotId: golden, defaultRegion: 'iad1', pool: poolConfigFromEnv(h.env) }
  })
  const poolRows = () => h.raw.prepare('SELECT * FROM sandbox_pool ORDER BY created_at').all() as Record<string, unknown>[]
  return { h, deps, poolRows }
}

describe('warm pool', () => {
  it('keeps a warm VM for the active build of an environment in use, and a create from it claims that VM', async () => {
    const { h, deps, poolRows } = await pooledHarness('1')
    h.vercel.buildResult = JSON.stringify({ repos: [{ url: 'https://github.com/acme/web.git', dir: 'acme/web', branch: 'main', commit: 'a'.repeat(40), lockfiles: {} }] })
    const env = await h.call('POST', '/v1/environments', { body: { name: 'Default', repos: [{ url: 'acme/web' }] } })
    const started = await h.call('POST', `/v1/environments/${env.body.environment.id}/builds`)
    ;[...h.vercel.buildCommands.values()].at(-1)!.exitCode = 0
    const build = (await h.call('GET', `/v1/environments/${env.body.environment.id}/builds/${started.body.build.id}`)).body.build
    expect(build.status).toBe('succeeded')
    const snapshot = h.raw.prepare('SELECT snapshot_id FROM environment_builds WHERE id = ?').get(build.id) as { snapshot_id: string }
    // Only built, never used: no warm VM for it yet.
    await maintainPool(deps())
    expect(poolRows().map((r) => r.snapshot_id)).toEqual([GOLDEN])
    // The first create from the environment misses (and boots from the build); then it is hot.
    const first = await h.call('POST', '/v1/sandboxes', { body: { ...create, workspaceId: 'ws-first', repo: { url: 'https://github.com/acme/web.git' } } })
    expect(first.body.sandbox.environmentBuildId).toBe(build.id)
    await maintainPool(deps())
    const images = poolRows().map((r) => r.snapshot_id).sort()
    expect(images).toEqual([GOLDEN, snapshot.snapshot_id].sort())
    const pooledFromBuild = poolRows().find((r) => r.snapshot_id === snapshot.snapshot_id)!.id
    const res = await h.call('POST', '/v1/sandboxes', { body: { ...create, repo: { url: 'https://github.com/acme/web.git' } } })
    expect(res.status).toBe(200)
    expect(res.body.sandbox).toMatchObject({ id: pooledFromBuild, environmentBuildId: build.id })
    // Two hours without use: the build's warm VM is recycled, the golden pool stays.
    h.advance(3 * 60 * MIN)
    await maintainPool(deps())
    expect(poolRows().map((r) => r.snapshot_id)).toEqual([GOLDEN])
  })

  it('is off unless SANDBOX_POOL_SIZE is a positive integer, and capped', () => {
    expect(poolConfigFromEnv({})).toBeUndefined()
    expect(poolConfigFromEnv({ SANDBOX_POOL_SIZE: '0' })).toBeUndefined()
    expect(poolConfigFromEnv({ SANDBOX_POOL_SIZE: 'x' })).toBeUndefined()
    expect(poolConfigFromEnv({ SANDBOX_POOL_SIZE: '50' })!.size).toBe(10)
  })

  it('boots ready VMs with egress denied, no orcad, and the id a create will take', async () => {
    const { h, deps, poolRows } = await pooledHarness()
    expect(await maintainPool(deps())).toEqual({ created: 2, recycled: 0, ready: 2 })
    expect(poolRows().map((r) => r.status)).toEqual(['ready', 'ready'])
    for (const box of h.vercel.boxes.values()) {
      expect(box.policy).toEqual({ allow: {} })
      expect(box.params.tags).toMatchObject({ orcaPool: '1', orcaEnv: 'test' })
      expect(box.params.name).toBe(`orca-test-${box.params.tags.orcaSandbox}`)
    }
    expect(h.vercel.commands).toEqual([])
    // Full already: a second tick does nothing.
    expect(await maintainPool(deps())).toEqual({ created: 0, recycled: 0, ready: 2 })
  })

  it('a create claims a pooled VM, applies the caller policy, extends the lease, and bills from the claim', async () => {
    const { h, deps, poolRows } = await pooledHarness('1')
    await maintainPool(deps())
    const pooledId = poolRows()[0]!.id as string
    h.advance(10 * MIN)
    const res = await h.call('POST', '/v1/sandboxes', { body: create })
    expect(res.status).toBe(200)
    const ready = HostedSandboxReadyResponseSchema.parse(res.body)
    expect(ready.sandbox.id).toBe(pooledId)
    const box = h.vercel.boxes.get(`orca-test-${pooledId}`)!
    expect(Object.keys(box.policy.allow)).toContain('registry.npmjs.org')
    expect(h.vercel.commands.some((c) => c.command === START_COMMAND && c.sessionId === box.sessionId)).toBe(true)
    // Lease runs 30 min from the claim; the 24 h deadline still counts from the real boot.
    expect(ready.sandbox.session!.leaseExpiresAt).toBe(h.now() + 30 * MIN)
    expect(ready.sandbox.session!.startedAt).toBe(h.now() - 10 * MIN)
    const row = h.raw.prepare('SELECT usage_settled_at FROM sandboxes WHERE id = ?').get(pooledId) as { usage_settled_at: number }
    expect(row.usage_settled_at).toBe(h.now())
    // The claim triggers a refill behind the response; the claimed VM is never handed out again.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(poolRows().map((r) => r.id)).not.toContain(pooledId)
    expect(poolRows()).toHaveLength(1)
  })

  it('falls back to a fresh VM when the pooled one is gone', async () => {
    const { h, deps, poolRows } = await pooledHarness('1')
    await maintainPool(deps())
    const pooledName = `orca-test-${poolRows()[0]!.id as string}`
    h.vercel.boxes.delete(pooledName)
    const res = await h.call('POST', '/v1/sandboxes', { body: create })
    expect(res.status).toBe(200)
    expect(res.body.sandbox.id).not.toBe(pooledName.replace('orca-test-', ''))
    expect(h.vercel.boxes.get(`orca-test-${res.body.sandbox.id}`)!.params.tags.orcaPool).toBeUndefined()
  })

  it('a failed adopt whose cleanup stops short still gives the caller a fresh VM (no sandbox_destroying conflict)', async () => {
    const { h, deps, poolRows } = await pooledHarness('1')
    await maintainPool(deps())
    const pooledId = poolRows()[0]!.id as string
    const pooledName = `orca-test-${pooledId}`
    const realPolicy = h.vercel.updateNetworkPolicy.bind(h.vercel)
    h.vercel.updateNetworkPolicy = async (sessionId, policy) => {
      if (sessionId === h.vercel.boxes.get(pooledName)?.sessionId) {
        throw new Error('policy update failed')
      }
      return realPolicy(sessionId, policy)
    }
    // The pooled VM's delete leaves a snapshot that will not delete yet: destroy stops at 'destroying'.
    const realDeleteSnapshot = h.vercel.deleteSnapshot.bind(h.vercel)
    h.vercel.deleteSnapshot = async (id) => {
      if (h.vercel.snapshots.get(id)?.sandboxName === pooledName) {
        throw new Error('snapshot still being written')
      }
      return realDeleteSnapshot(id)
    }
    const res = await h.call('POST', '/v1/sandboxes', { body: create })
    expect(res.status).toBe(200)
    expect(res.body.sandbox.id).not.toBe(pooledId)
    const abandoned = h.raw.prepare('SELECT status, workspace_id FROM sandboxes WHERE id = ?').get(pooledId) as { status: string; workspace_id: string }
    expect(abandoned.status).not.toBe('destroyed')
    expect(abandoned.workspace_id).toBe(`ws-1#abandoned:${pooledId}`)
    // The cron finishes the abandoned row once the provider lets go.
    h.vercel.deleteSnapshot = realDeleteSnapshot
    h.advance(30 * MIN)
    await h.reconcile()
    expect((h.raw.prepare('SELECT status FROM sandboxes WHERE id = ?').get(pooledId) as { status: string }).status).toBe('destroyed')
  })

  it('skips the pool for sizes and regions it does not hold', async () => {
    const { h, deps, poolRows } = await pooledHarness('1')
    await maintainPool(deps())
    const res = await h.call('POST', '/v1/sandboxes', { body: { ...create, machineSize: 'large' } })
    expect(res.status).toBe(200)
    expect(poolRows()).toHaveLength(1)
  })

  it('recycles VMs past max age or on an old golden image, deleting them and their snapshots', async () => {
    const { h, deps, poolRows } = await pooledHarness('1')
    await maintainPool(deps())
    const first = poolRows()[0]!.provider_name as string
    h.advance(21 * MIN)
    expect(await maintainPool(deps())).toEqual({ created: 1, recycled: 1, ready: 1 })
    expect(h.vercel.boxes.has(first)).toBe(false)
    expect([...h.vercel.snapshots.values()].filter((s) => s.sandboxName === first && s.status !== 'deleted')).toEqual([])

    const second = poolRows()[0]!.provider_name as string
    expect(await maintainPool(deps('snap_newer'))).toEqual({ created: 1, recycled: 1, ready: 1 })
    expect(h.vercel.boxes.has(second)).toBe(false)
    expect(poolRows()[0]!.snapshot_id).toBe('snap_newer')
  })

  it('one maintainer at a time: an overlapping refill is skipped, never doubles the pool', async () => {
    const { h, deps, poolRows } = await pooledHarness('2')
    const [a, b] = await Promise.all([maintainPool(deps()), maintainPool(deps())])
    expect([a, b]).toContainEqual({ skipped: 'busy' })
    expect(poolRows()).toHaveLength(2)
    expect(h.vercel.boxes.size).toBe(2)
    // The lease is released: the next tick runs.
    expect(await maintainPool(deps())).toEqual({ created: 0, recycled: 0, ready: 2 })
  })

  it('a miss refills too (empty or stale pool), so the next create hits without waiting for the cron', async () => {
    const { h, poolRows } = await pooledHarness('1')
    const first = await h.call('POST', '/v1/sandboxes', { body: create })
    expect(first.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(poolRows().map((r) => r.status)).toEqual(['ready'])
    const second = await h.call('POST', '/v1/sandboxes', { body: { ...create, workspaceId: 'ws-2' } })
    expect(second.body.sandbox.id).not.toBe(first.body.sandbox.id)
    expect(h.vercel.boxes.get(`orca-test-${second.body.sandbox.id}`)!.params.tags.orcaPool).toBe('1')
  })

  it('drains when the pool is turned off', async () => {
    const { h, deps, poolRows } = await pooledHarness('2')
    await maintainPool(deps())
    const off: PoolDeps = { ...deps(), config: { ...deps().config, pool: undefined } }
    expect(await maintainPool(off)).toEqual({ created: 0, recycled: 2, ready: 0 })
    expect(poolRows()).toEqual([])
    expect(h.vercel.boxes.size).toBe(0)
  })
})
