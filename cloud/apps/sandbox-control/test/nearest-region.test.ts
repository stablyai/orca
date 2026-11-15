// Nearest region: a create or a new environment with nothing pinned starts in the served region
// nearest the caller (Cloudflare's request geolocation); explicit regions and environments win.
import { describe, expect, it } from 'vitest'
import { refreshStaleEnvironments } from '../src/environment-golden-refresh'
import { maintainPool, poolConfigFromEnv, type PoolDeps } from '../src/pool'
import { nearestRegions, regionsByDistance, requestGeo, servedRegions } from '../src/regions'
import { GOLDEN, createHarness } from './harness'

const SAN_FRANCISCO = { latitude: '37.7749', longitude: '-122.4194', continent: 'NA', country: 'US' }
const NEW_YORK = { latitude: '40.7128', longitude: '-74.0060', continent: 'NA', country: 'US' }
const LONDON = { latitude: '51.5072', longitude: '-0.1276', continent: 'EU', country: 'GB' }
const TOKYO = { latitude: '35.6762', longitude: '139.6503', continent: 'AS', country: 'JP' }
const PDX1_GOLDEN = 'snap_pdx1'
const REPO = 'https://github.com/acme/web.git'

function located(cf: Record<string, unknown>): Request {
  const request = new Request('https://sandbox.test/v1/sandboxes')
  Object.defineProperty(request, 'cf', { value: cf })
  return request
}

describe('regionsByDistance', () => {
  const served = ['pdx1', 'iad1']
  it('orders the served regions nearest the caller first', () => {
    expect(regionsByDistance(requestGeo(located(SAN_FRANCISCO)), served)).toEqual(['pdx1', 'iad1'])
    expect(regionsByDistance(requestGeo(located(NEW_YORK)), served)).toEqual(['iad1', 'pdx1'])
    expect(regionsByDistance(requestGeo(located(LONDON)), served)).toEqual(['iad1', 'pdx1'])
    expect(regionsByDistance(requestGeo(located(TOKYO)), served)).toEqual(['pdx1', 'iad1'])
    expect(regionsByDistance(requestGeo(located(LONDON)), ['pdx1', 'iad1', 'fra1'])).toEqual(['fra1', 'iad1', 'pdx1'])
  })

  it('uses the continent when Cloudflare has no coordinates, and keeps the configured order without either', () => {
    expect(regionsByDistance({ continent: 'EU' }, served)).toEqual(['iad1', 'pdx1'])
    expect(regionsByDistance({ continent: 'XX' }, served)).toEqual(served)
    expect(regionsByDistance(null, served)).toEqual(served)
  })

  it('puts a region with no known site after the located ones, in its configured place', () => {
    expect(regionsByDistance(requestGeo(located(NEW_YORK)), ['zzz1', 'pdx1', 'iad1'])).toEqual(['iad1', 'pdx1', 'zzz1'])
  })

  it('reads request.cf, and nothing outside the Workers runtime', () => {
    expect(requestGeo(located(NEW_YORK))).toEqual({ latitude: 40.7128, longitude: -74.006, continent: 'NA' })
    expect(requestGeo(located({ continent: 'EU' }))).toEqual({ continent: 'EU' })
    expect(requestGeo(located({ latitude: 'x', longitude: '1' }))).toBeNull()
    expect(requestGeo(new Request('https://sandbox.test/'))).toBeNull()
  })

  it('decides nothing when off, unlocated, or with a single served region', () => {
    expect(nearestRegions(located(NEW_YORK), served)).toEqual(['iad1', 'pdx1'])
    expect(nearestRegions(located(NEW_YORK), served, false)).toBeUndefined()
    expect(nearestRegions(new Request('https://sandbox.test/'), served)).toBeUndefined()
    expect(nearestRegions(located(NEW_YORK), ['pdx1'])).toBeUndefined()
    expect(servedRegions({ defaultRegion: 'pdx1', fallbackRegions: ['iad1', 'pdx1'] })).toEqual(['pdx1', 'iad1'])
  })
})

/** pdx1 the default and iad1 its fallback, each with an active golden (iad1's is the seed, GOLDEN). */
async function twoRegions(overrides: Record<string, string> = {}, waitUntil?: (work: Promise<unknown>) => void) {
  const h = await createHarness({ VERCEL_REGION: 'pdx1', VERCEL_FALLBACK_REGIONS: 'iad1', ...overrides }, waitUntil ? { waitUntil } : {})
  h.raw
    .prepare(
      `INSERT INTO golden_images (id, region, source, status, snapshot_id, created_at, updated_at, activated_at)
       VALUES ('g1', 'pdx1', 'seed', 'active', ?, 1, 1, 1)`
    )
    .run(PDX1_GOLDEN)
  const box = (id: string) => h.vercel.boxes.get(`orca-test-${id}`)!.params
  return { h, box }
}

describe('nearest region on create', () => {
  it('creates in the served region nearest the caller, on that region’s golden', async () => {
    const { h, box } = await twoRegions()
    const east = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-ny', machineSize: 'standard' }, cf: NEW_YORK })
    expect(east.status).toBe(200)
    expect(east.body.sandbox.region).toBe('iad1')
    expect(box(east.body.sandbox.id)).toMatchObject({ region: 'iad1', snapshotId: GOLDEN })
    const west = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-sf', machineSize: 'standard' }, cf: SAN_FRANCISCO })
    expect(west.body.sandbox.region).toBe('pdx1')
    expect(box(west.body.sandbox.id)).toMatchObject({ region: 'pdx1', snapshotId: PDX1_GOLDEN })
    // Unlocated (no request.cf): the default region, as before.
    const unknown = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-x', machineSize: 'standard' } })
    expect(unknown.body.sandbox.region).toBe('pdx1')
  })

  it('keeps an explicit region authoritative', async () => {
    const { h } = await twoRegions()
    const pinned = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard', region: 'pdx1' }, cf: NEW_YORK })
    expect(pinned.body.sandbox.region).toBe('pdx1')
    // Pinned means pinned: a capacity failure there is not moved to the nearer region.
    h.vercel.failCreateRegions.add('pdx1')
    const refused = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-2', machineSize: 'standard', region: 'pdx1' }, cf: NEW_YORK })
    expect(refused.status).not.toBe(200)
  })

  it('never picks a region without an active golden, and falls back to the next nearest on capacity', async () => {
    // iad1 is the default here and pdx1 has no image: a caller nearest pdx1 still lands in iad1.
    const h = await createHarness({ VERCEL_REGION: 'iad1', VERCEL_FALLBACK_REGIONS: 'pdx1' })
    const west = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-sf', machineSize: 'standard' }, cf: SAN_FRANCISCO })
    expect(west.body.sandbox.region).toBe('iad1')

    const { h: two } = await twoRegions()
    two.vercel.failCreateRegions.add('iad1')
    const moved = await two.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-ny', machineSize: 'standard' }, cf: NEW_YORK })
    expect(moved.status).toBe(200)
    expect(moved.body.sandbox.region).toBe('pdx1')
  })

  it('VERCEL_NEAREST_REGION=off keeps every create in the default region', async () => {
    const { h } = await twoRegions({ VERCEL_NEAREST_REGION: 'off' })
    const east = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-ny', machineSize: 'standard' }, cf: NEW_YORK })
    expect(east.body.sandbox.region).toBe('pdx1')
  })

  it('resumes a sandbox in the region it was created in, wherever the caller is now', async () => {
    const { h, box } = await twoRegions()
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-ny', machineSize: 'standard' }, cf: NEW_YORK })
    const id = created.body.sandbox.id
    expect((await h.call('POST', `/v1/sandboxes/${id}/suspend`, { cf: SAN_FRANCISCO })).status).toBe(200)
    const resumed = await h.call('POST', `/v1/sandboxes/${id}/resume`, { cf: SAN_FRANCISCO })
    expect(resumed.status).toBe(200)
    expect(resumed.body.sandbox.region).toBe('iad1')
    expect(h.vercel.boxes.size).toBe(1)
    expect(box(id).region).toBe('iad1')
    expect((h.raw.prepare('SELECT region FROM sandboxes WHERE id = ?').get(id) as { region: string }).region).toBe('iad1')
  })
})

describe('nearest region for environments', () => {
  async function environmentIn(cf: Record<string, unknown>) {
    const { h, box } = await twoRegions()
    h.vercel.buildResult = JSON.stringify({ repos: [{ url: REPO, dir: 'acme/web', branch: 'main', commit: 'a'.repeat(40), lockfiles: {} }] })
    const env = await h.call('POST', '/v1/environments', { body: { name: 'Default', repos: [{ url: 'acme/web' }] }, cf })
    expect(env.status).toBe(200)
    const envId = env.body.environment.id as string
    const started = await h.call('POST', `/v1/environments/${envId}/builds`, { cf: SAN_FRANCISCO })
    ;[...h.vercel.buildCommands.values()].at(-1)!.exitCode = 0
    const build = (await h.call('GET', `/v1/environments/${envId}/builds/${started.body.build.id}`)).body.build
    expect(build.status).toBe('succeeded')
    return { h, box, envId, buildId: build.id as string }
  }

  it('records the region nearest the admin who creates it, builds there, and boots its workspaces there', async () => {
    const { h, box, envId, buildId } = await environmentIn(NEW_YORK)
    expect(h.raw.prepare('SELECT region FROM environments WHERE id = ?').get(envId)).toEqual({ region: 'iad1' })
    // Built in iad1 from iad1's golden, whoever pressed Build and wherever they are.
    expect(h.raw.prepare('SELECT region, base_snapshot_id FROM environment_builds WHERE id = ?').get(buildId)).toEqual({ region: 'iad1', base_snapshot_id: GOLDEN })
    // A teammate on the west coast boots from it in iad1: the snapshot only boots there.
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-sf', machineSize: 'standard', repo: { url: REPO } }, cf: SAN_FRANCISCO })
    expect(created.status).toBe(200)
    expect(created.body.sandbox).toMatchObject({ region: 'iad1', environmentBuildId: buildId })
    expect(box(created.body.sandbox.id).region).toBe('iad1')
  })

  it('compares an environment with its own region’s golden: no refresh churn for an iad1 environment', async () => {
    const { h, envId } = await environmentIn(NEW_YORK)
    const deps = {
      db: h.env.SANDBOX_DB,
      provider: h.vercel,
      entitlements: { checkStart: async () => h.billing.decision, reportUsage: async () => h.billing.usageAnswer, listSuspensions: async () => [] },
      now: h.now,
      config: { environment: 'test', goldenSnapshotId: PDX1_GOLDEN, goldenSnapshots: { pdx1: PDX1_GOLDEN, iad1: GOLDEN }, region: 'pdx1', regions: ['pdx1', 'iad1'] }
    }
    expect(await refreshStaleEnvironments(deps as never, { minIntervalMs: 0 })).toMatchObject({ stale: 0, started: 0 })
    // An environment from before regions were recorded lives in the default region: its iad1 build is stale.
    h.raw.prepare('UPDATE environments SET region = NULL WHERE id = ?').run(envId)
    expect(await refreshStaleEnvironments(deps as never, { minIntervalMs: 0 })).toMatchObject({ stale: 1, started: 1 })
    expect(h.raw.prepare('SELECT region, base_snapshot_id FROM environment_builds WHERE environment_id = ? ORDER BY number DESC').get(envId)).toEqual({
      region: 'pdx1',
      base_snapshot_id: PDX1_GOLDEN
    })
  })

  it('an environment made in the default region (west coast admin) stays there', async () => {
    const { h, envId, buildId } = await environmentIn(SAN_FRANCISCO)
    expect(h.raw.prepare('SELECT region FROM environments WHERE id = ?').get(envId)).toEqual({ region: 'pdx1' })
    expect(h.raw.prepare('SELECT region, base_snapshot_id FROM environment_builds WHERE id = ?').get(buildId)).toEqual({ region: 'pdx1', base_snapshot_id: PDX1_GOLDEN })
  })

  it('an automatic environment lives where the create that made it ran', async () => {
    const pending: Promise<unknown>[] = []
    const { h } = await twoRegions({ AUTO_ENVIRONMENTS: 'on' }, (work) => void pending.push(work))
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'w1', machineSize: 'standard', repo: { url: REPO } }, cf: NEW_YORK })
    expect(created.body.sandbox.region).toBe('iad1')
    while (pending.length > 0) {
      await Promise.all(pending.splice(0))
    }
    expect(h.raw.prepare(`SELECT region FROM environments WHERE kind = 'auto'`).all()).toEqual([{ region: 'iad1' }])
    expect(h.raw.prepare('SELECT region, base_snapshot_id FROM environment_builds').all()).toEqual([{ region: 'iad1', base_snapshot_id: GOLDEN }])
  })
})

describe('warm pool per served region', () => {
  it('keeps warm VMs in every served region, and a create claims one in its nearest region', async () => {
    const { h } = await twoRegions({ SANDBOX_POOL_SIZE: '1' })
    const deps: PoolDeps = {
      db: h.env.SANDBOX_DB,
      provider: h.vercel,
      now: h.now,
      config: {
        environment: 'test',
        goldenSnapshotId: PDX1_GOLDEN,
        goldenSnapshots: { pdx1: PDX1_GOLDEN, iad1: GOLDEN },
        defaultRegion: 'pdx1',
        fallbackRegions: ['iad1'],
        pool: poolConfigFromEnv(h.env)
      }
    }
    expect(await maintainPool(deps)).toMatchObject({ created: 2 })
    const pool = () => h.raw.prepare(`SELECT id, region, snapshot_id FROM sandbox_pool WHERE status = 'ready' ORDER BY region`).all() as { id: string; region: string; snapshot_id: string }[]
    expect(pool().map(({ region, snapshot_id }) => ({ region, snapshot_id }))).toEqual([
      { region: 'iad1', snapshot_id: GOLDEN },
      { region: 'pdx1', snapshot_id: PDX1_GOLDEN }
    ])
    const warmEast = pool().find((vm) => vm.region === 'iad1')!.id
    const east = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-ny', machineSize: 'standard' }, cf: NEW_YORK })
    expect(east.body.sandbox).toMatchObject({ id: warmEast, region: 'iad1' })
  })
})
