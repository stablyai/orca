import { describe, expect, it } from 'vitest'
import type { GoldenImageProviderApi } from '../src/golden-image-provider'
import { advanceGoldenImages, currentGoldenSnapshotId, type GoldenImageDeps } from '../src/golden-images'
import { createFakeD1 } from './d1-fake'
import { createFakeVercel } from './fake-vercel'
import { createHarness } from './harness'
import { touchesVm } from '../src/golden-source'

const HOUR = 60 * 60_000

function setup(options: { source?: string; seedExpiresInMs?: number; fetch?: typeof fetch; github?: GoldenImageDeps['config']['github'] } = {}) {
  const { db, raw } = createFakeD1()
  let now = 1_800_000_000_000
  const vercel = createFakeVercel(() => now)
  const expiries = new Map<string, number | null>([['snap_seed', options.seedExpiresInMs === undefined ? null : now + options.seedExpiresInMs]])
  vercel.snapshots.set('snap_seed', { id: 'snap_seed', status: 'created', sourceSessionId: 'sess_seed', sandboxName: 'build', creationMethod: 'manual', createdAt: now })
  const commands = new Map<string, number | null>()
  const commandReads: { wait?: boolean; waitMs?: number }[] = []
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
    async getCommand(_session, commandId, options) {
      commandReads.push(options ?? {})
      return { exitCode: commands.get(commandId) ?? null }
    },
    async streamCommandLogs() {
      return new Response('').body!
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
    config: { environment: 'test', region: 'iad1', expirationMs: 0, seedSnapshotId: 'snap_seed', source: options.source, fetch: options.fetch, github: options.github }
  }
  return {
    deps,
    vercel,
    commands,
    commandReads,
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

  it('tracks a git branch: rebuilds orcad from HEAD when HEAD touches VM code, never for renderer-only changes', async () => {
    const SHA_A = 'a'.repeat(40)
    const SHA_B = 'b'.repeat(40)
    let head = SHA_A
    let changed: string[] = []
    const appCalls: string[] = []
    const github: GoldenImageDeps['config']['github'] = async (method, path) => {
      appCalls.push(`${method} ${path}`)
      return path.endsWith('/installation') ? Response.json({ id: 9 }) : Response.json({ token: 'ghs_read' })
    }
    const fetchFake = (async (url: string) => {
      if (url.includes('/commits/')) return Response.json({ sha: head })
      if (url.includes('/compare/')) return Response.json({ files: changed.map((filename) => ({ filename })) })
      return new Response('nope', { status: 404 })
    }) as typeof fetch
    const t = setup({ source: 'git:https://github.com/acme/orca-private#cloud/integration', github, fetch: fetchFake })
    expect(await advanceGoldenImages(t.deps)).toBe('seeded')
    // The seed carries no commit: build HEAD.
    expect(await advanceGoldenImages(t.deps)).toBe('source-started')
    expect(appCalls).toEqual(['GET /repos/acme/orca-private/installation', 'POST /app/installations/9/access_tokens'])
    t.commands.set([...t.commands.keys()][0]!, 0)
    expect(await advanceGoldenImages(t.deps)).toBe('built')
    // Exit codes come only to waiting readers (W1/W9): every poll is a bounded wait=true read.
    expect(t.commandReads.length).toBeGreaterThan(0)
    expect(t.commandReads.every((read) => read.wait === true && (read.waitMs ?? 0) > 0)).toBe(true)
    expect(await advanceGoldenImages(t.deps)).toBe('activated')
    const active = () => t.raw.prepare(`SELECT bundle_sha256 FROM golden_images WHERE status = 'active'`).get() as { bundle_sha256: string }
    expect(active().bundle_sha256).toBe(`git:${SHA_A}`)
    expect(await advanceGoldenImages(t.deps)).toBe('idle')
    // Renderer-only change: no rebuild.
    head = SHA_B
    changed = ['src/renderer/src/components/Foo.tsx']
    expect(await advanceGoldenImages(t.deps)).toBe('idle')
    // A host RPC change: rebuild.
    changed = ['src/renderer/src/components/Foo.tsx', 'src/main/runtime/rpc/methods/ports.ts']
    expect(await advanceGoldenImages(t.deps)).toBe('source-started')
  })

  it('classifies VM paths', () => {
    expect(touchesVm('src/main/orcad/orcad-entry.ts')).toBe(true)
    expect(touchesVm('src/shared/hosted-sandbox/wire.ts')).toBe(true)
    expect(touchesVm('pnpm-lock.yaml')).toBe(true)
    expect(touchesVm('src/renderer/src/App.tsx')).toBe(false)
    expect(touchesVm('cloud/apps/sandbox-control/image/vm/orca-desktop-proxy')).toBe(true)
    expect(touchesVm('cloud/apps/sandbox-control/image/golden-image.test.ts')).toBe(false)
    expect(touchesVm('cloud/apps/billing/src/index.ts')).toBe(false)
  })
})
