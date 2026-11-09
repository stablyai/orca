import { describe, expect, it } from 'vitest'
import type { GoldenImageProviderApi } from '../src/golden-image-provider'
import { advanceGoldenImages, currentGoldenSnapshotId, type GoldenImageDeps } from '../src/golden-images'
import { createFakeD1 } from './d1-fake'
import { createFakeVercel } from './fake-vercel'
import { createHarness } from './harness'

const HOUR = 60 * 60_000

function setup(options: { source?: string; seedExpiresInMs?: number; fetch?: typeof fetch } = {}) {
  const { db, raw } = createFakeD1()
  let now = 1_800_000_000_000
  const vercel = createFakeVercel(() => now)
  const expiries = new Map<string, number | null>([['snap_seed', options.seedExpiresInMs === undefined ? null : now + options.seedExpiresInMs]])
  vercel.snapshots.set('snap_seed', { id: 'snap_seed', status: 'created', sourceSessionId: 'sess_seed', sandboxName: 'build', creationMethod: 'manual', createdAt: now })
  const commands = new Map<string, number | null>()
  let counter = 0
  const golden: GoldenImageProviderApi = {
    async createBuildSandbox(params) {
      return vercel.createSandbox({ ...params, snapshotId: 'runtime:node24', ports: [], networkPolicy: { allow: {} }, snapshotExpirationMs: 0 })
    },
    async createSnapshot(sessionId, expirationMs) {
      const box = [...vercel.boxes.values()].find((b) => b.sessionId === sessionId)!
      box.status = 'stopped'
      const id = `snap_gold_${++counter}`
      vercel.snapshots.set(id, { id, status: 'created', sourceSessionId: sessionId, sandboxName: box.params.name, creationMethod: 'manual', createdAt: now })
      expiries.set(id, expirationMs === 0 ? null : now + expirationMs)
      return id
    },
    async deleteBuildSandbox(name) {
      vercel.boxes.delete(name)
    },
    async startCommand() {
      const id = `cmd_${++counter}`
      commands.set(id, null)
      return id
    },
    async getCommand(_session, commandId) {
      return { exitCode: commands.get(commandId) ?? null }
    },
    async getSnapshot(id) {
      const snapshot = vercel.snapshots.get(id)
      return snapshot ? { id, status: snapshot.status, expiresAt: expiries.get(id) ?? null } : null
    }
  }
  const deps: GoldenImageDeps = {
    db,
    provider: { ...vercel, ...golden },
    now: () => now,
    config: { environment: 'test', region: 'iad1', expirationMs: 0, seedSnapshotId: 'snap_seed', source: options.source, fetch: options.fetch }
  }
  return {
    deps,
    vercel,
    commands,
    raw,
    advance: (ms: number) => (now += ms),
    statuses: () => raw.prepare('SELECT source, status, snapshot_id FROM golden_images ORDER BY source DESC').all()
  }
}

describe('golden image rotation', () => {
  it('refreshes an expiring image, smoke-tests it, then swaps it in and keeps the previous one', async () => {
    const t = setup({ seedExpiresInMs: 20 * HOUR })
    expect(await advanceGoldenImages(t.deps)).toBe('seeded')
    expect(await advanceGoldenImages(t.deps)).toBe('refresh-started')
    // Not active until the smoke boot passes.
    expect(await currentGoldenSnapshotId(t.deps.db)).toBe('snap_seed')
    expect(await advanceGoldenImages(t.deps)).toBe('activated')
    expect(await currentGoldenSnapshotId(t.deps.db)).toBe('snap_gold_1')
    expect(t.statuses()).toEqual([
      { source: 'seed', status: 'retired', snapshot_id: 'snap_seed' },
      { source: 'clone:snap_seed', status: 'active', snapshot_id: 'snap_gold_1' }
    ])
    expect(t.vercel.snapshots.get('snap_seed')!.status).toBe('created')
    // The new image never expires, so nothing more to do; build and smoke boxes are gone.
    expect(await advanceGoldenImages(t.deps)).toBe('idle')
    expect([...t.vercel.boxes.keys()]).toEqual([])
  })

  it('keeps serving the previous image when the candidate fails its smoke boot', async () => {
    const t = setup({ seedExpiresInMs: 20 * HOUR })
    await advanceGoldenImages(t.deps)
    await advanceGoldenImages(t.deps)
    t.vercel.failStart = true
    expect(await advanceGoldenImages(t.deps)).toBe('failed')
    expect(await currentGoldenSnapshotId(t.deps.db)).toBe('snap_seed')
    expect(t.vercel.snapshots.get('snap_gold_1')!.status).toBe('deleted')
    // Backs off instead of rebuilding every five minutes.
    expect(await advanceGoldenImages(t.deps)).toBe('idle')
  })

  it('builds from a new orca-server release, waits for the build, and activates it after smoke', async () => {
    const sha = 'c'.repeat(64)
    const fetchRelease: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/releases/latest')) {
        return Response.json({ tag_name: 'v1.4.256' })
      }
      return new Response(`${sha}  orca-server-linux-x64.tar.gz\n`)
    }
    const t = setup({ source: 'release:latest', fetch: fetchRelease })
    expect(await advanceGoldenImages(t.deps)).toBe('seeded')
    expect(await advanceGoldenImages(t.deps)).toBe('release-started')
    expect(await advanceGoldenImages(t.deps)).toBe('building')
    t.commands.set([...t.commands.keys()][0]!, 0)
    expect(await advanceGoldenImages(t.deps)).toBe('built')
    expect(await advanceGoldenImages(t.deps)).toBe('activated')
    expect(t.raw.prepare(`SELECT source, bundle_sha256 FROM golden_images WHERE status = 'active'`).get()).toEqual({
      source: 'release:v1.4.256',
      bundle_sha256: sha
    })
    expect(await advanceGoldenImages(t.deps)).toBe('idle')
  })

  it('keeps refreshing when the release has no orca-server tarball yet', async () => {
    const t = setup({ source: 'release:v1.4.254', fetch: async () => new Response('', { status: 404 }) })
    await advanceGoldenImages(t.deps)
    expect(await advanceGoldenImages(t.deps)).toBe('release-unavailable')
  })

  it('serves creates from the rotated image, not the seed var', async () => {
    const h = await createHarness()
    h.raw
      .prepare(`INSERT INTO golden_images (id, source, status, snapshot_id, created_at, updated_at, activated_at) VALUES ('g1', 'seed', 'active', 'snap_rotated', 1, 1, 1)`)
      .run()
    await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' } })
    expect([...h.vercel.boxes.values()][0]!.params.snapshotId).toBe('snap_rotated')
  })
})

