import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GoldenImageProviderApi } from '../src/golden-image-provider'
import { activeGoldenSnapshots, advanceGoldenImages, currentGoldenSnapshotId, ensureEntryPoints, entryPointsVersion, type GoldenImageDeps } from '../src/golden-images'
import { VM_SCRIPTS_STAMP } from '../image/vm-scripts.generated'
import { createFakeD1 } from './d1-fake'
import { SCRIPTS_STAMP_PATH, createFakeVercel } from './fake-vercel'
import { GOLDEN, createHarness } from './harness'
import { touchesVm } from '../src/golden-source'
import { egressAllowlistFor } from '../src/network-policy'

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
    expect(await currentGoldenSnapshotId(t.deps.db, 'iad1')).toBe('snap_seed')
    expect(await advanceGoldenImages(t.deps)).toBe('activated')
    expect(await currentGoldenSnapshotId(t.deps.db, 'iad1')).toBe('snap_gold_1')
    expect(t.statuses()).toEqual([
      { source: 'seed', status: 'retired', snapshot_id: 'snap_seed' },
      { source: 'clone:snap_seed', status: 'active', snapshot_id: 'snap_gold_1' }
    ])
    expect(t.vercel.snapshots.get('snap_seed')!.status).toBe('created')
    // The new image never expires, so nothing more to do; build and smoke boxes are gone.
    expect(await advanceGoldenImages(t.deps)).toBe('idle')
    expect([...t.vercel.boxes.keys()]).toEqual([])
  })

  it('smoke-boots under the configured platform hosts, not the built-in *.onorca.dev', async () => {
    const t = setup({ seedExpiresInMs: 20 * HOUR })
    const policies: Record<string, unknown>[] = []
    const create = t.deps.provider.createSandbox.bind(t.deps.provider)
    const deps: GoldenImageDeps = {
      ...t.deps,
      provider: {
        ...t.deps.provider,
        createSandbox: async (params) => {
          if (params.name.includes('goldsmoke')) {
            policies.push(params.networkPolicy.allow)
          }
          return create(params)
        }
      },
      config: { ...t.deps.config, egressAllowlist: egressAllowlistFor('*.orca.dev') }
    }
    await advanceGoldenImages(deps)
    await advanceGoldenImages(deps)
    expect(await advanceGoldenImages(deps)).toBe('activated')
    expect(policies).toHaveLength(1)
    expect(policies[0]).toHaveProperty(['*.orca.dev'])
    expect(policies[0]).not.toHaveProperty(['*.onorca.dev'])
  })

  it('keeps serving the previous image when the candidate fails its smoke boot', async () => {
    const t = setup({ seedExpiresInMs: 20 * HOUR })
    await advanceGoldenImages(t.deps)
    await advanceGoldenImages(t.deps)
    t.vercel.failStart = true
    expect(await advanceGoldenImages(t.deps)).toBe('failed')
    expect(await currentGoldenSnapshotId(t.deps.db, 'iad1')).toBe('snap_seed')
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

  it('keeps one active image per region: a region without one builds its own from source', async () => {
    const SHA = 'a'.repeat(40)
    const github: GoldenImageDeps['config']['github'] = async (_method, path) =>
      path.endsWith('/installation') ? Response.json({ id: 9 }) : Response.json({ token: 'ghs_read' })
    const fetchFake = (async (url: string) =>
      url.includes('/commits/') ? Response.json({ sha: SHA }) : Response.json({ files: [] })) as typeof fetch
    const t = setup({ source: 'git:https://github.com/acme/orca-private#cloud/integration', github, fetch: fetchFake })
    const iad1 = t.deps
    // The seed var is an iad1 snapshot: pdx1 never adopts it.
    const pdx1: GoldenImageDeps = { ...t.deps, config: { ...t.deps.config, region: 'pdx1', seedSnapshotId: undefined } }
    expect(await advanceGoldenImages(iad1)).toBe('seeded')
    expect(await advanceGoldenImages(pdx1)).toBe('source-started')
    expect([...t.vercel.boxes.values()].map((b) => b.params.region)).toEqual(['pdx1'])
    t.commands.set([...t.commands.keys()][0]!, 0)
    expect(await advanceGoldenImages(pdx1)).toBe('built')
    expect(await advanceGoldenImages(pdx1)).toBe('activated')
    // Activating pdx1's image left iad1's active.
    expect(await currentGoldenSnapshotId(t.deps.db, 'iad1')).toBe('snap_seed')
    expect(await currentGoldenSnapshotId(t.deps.db, 'pdx1')).toBe('snap_gold_2')
    expect(await activeGoldenSnapshots(t.deps.db)).toEqual({ iad1: 'snap_seed', pdx1: 'snap_gold_2' })
    expect(await advanceGoldenImages(pdx1)).toBe('idle')
    // iad1 rebuilds the same commit in its own region.
    expect(await advanceGoldenImages(iad1)).toBe('source-started')
    expect(t.raw.prepare(`SELECT region FROM golden_images WHERE status = 'building'`).all()).toEqual([{ region: 'iad1' }])
  })

  it('creates in the default region on its image, falls back on capacity, and never moves a pinned create', async () => {
    const h = await createHarness({ VERCEL_REGION: 'pdx1', VERCEL_FALLBACK_REGIONS: 'iad1' })
    h.raw
      .prepare(`INSERT INTO golden_images (id, region, source, status, snapshot_id, created_at, updated_at, activated_at) VALUES ('g1', 'pdx1', 'seed', 'active', 'snap_pdx1', 1, 1, 1)`)
      .run()
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' } })
    expect(created.status).toBe(200)
    expect(created.body.sandbox.region).toBe('pdx1')
    expect(h.vercel.boxes.get(`orca-test-${created.body.sandbox.id}`)!.params).toMatchObject({ region: 'pdx1', snapshotId: 'snap_pdx1' })

    h.vercel.failCreateRegions.add('pdx1')
    const fellBack = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-2', machineSize: 'standard' } })
    expect(fellBack.status).toBe(200)
    expect(fellBack.body.sandbox.region).toBe('iad1')
    // iad1 boots its own region's image (the seed), never pdx1's.
    expect(h.vercel.boxes.get(`orca-test-${fellBack.body.sandbox.id}`)!.params).toMatchObject({ region: 'iad1', snapshotId: GOLDEN })

    const pinned = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-3', machineSize: 'standard', region: 'pdx1' } })
    expect(pinned.status).not.toBe(200)
    // A region with no image is refused up front rather than booted from another region's snapshot.
    const unknown = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-4', machineSize: 'standard', region: 'sfo1' } })
    expect(unknown.status).toBe(409)
  })

  it('keeps creating in the fallback region until the default region has an image', async () => {
    const h = await createHarness({ VERCEL_REGION: 'pdx1', VERCEL_FALLBACK_REGIONS: 'iad1' })
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' } })
    expect(created.status).toBe(200)
    expect(created.body.sandbox.region).toBe('iad1')
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

describe('ensureEntryPoints (never installs older VM scripts than the image has)', () => {
  async function box(files: Record<string, string> = {}) {
    const vercel = createFakeVercel(() => 0)
    const created = await vercel.createSandbox({
      name: 'sbx',
      snapshotId: GOLDEN,
      vcpus: 2,
      region: 'iad1',
      timeoutMs: 60_000,
      ports: [],
      networkPolicy: { allow: {} },
      snapshotExpirationMs: 0,
      tags: {}
    })
    const vm = vercel.boxes.get('sbx')!
    for (const [path, body] of Object.entries(files)) {
      vm.files.set(path, body)
    }
    const installs = () => vercel.commands.filter((c) => c.command === 'bash' && c.args?.[1]?.includes('echo synced')).length
    return { vercel, vm, sessionId: created.session.id, installs }
  }
  const marker = `/opt/orca/bin/.entry-points-${entryPointsVersion()}`

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('skips an image with a newer stamp and logs it (a Worker deployed behind its golden)', async () => {
    const t = await box({ [SCRIPTS_STAMP_PATH]: `${VM_SCRIPTS_STAMP + 1}\n` })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await ensureEntryPoints({ provider: t.vercel }, t.sessionId)
    expect(t.installs()).toBe(0)
    expect(t.vm.files.get(SCRIPTS_STAMP_PATH)).toBe(`${VM_SCRIPTS_STAMP + 1}\n`)
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'entry_points_skip_older_worker', image: VM_SCRIPTS_STAMP + 1, worker: VM_SCRIPTS_STAMP }))
    // One probe round trip, nothing else.
    expect(t.vercel.commands).toHaveLength(1)
  })

  it('reinstalls over an older stamp, and records the Worker stamp and marker', async () => {
    const t = await box({ [SCRIPTS_STAMP_PATH]: `${VM_SCRIPTS_STAMP - 1}\n` })
    await ensureEntryPoints({ provider: t.vercel }, t.sessionId)
    expect(t.installs()).toBe(1)
    expect(t.vm.files.get(SCRIPTS_STAMP_PATH)).toBe(`${VM_SCRIPTS_STAMP}\n`)
    expect(t.vm.files.has(marker)).toBe(true)
  })

  it('reinstalls an image without a stamp (images from before stamps still get member scripts)', async () => {
    const t = await box()
    await ensureEntryPoints({ provider: t.vercel }, t.sessionId)
    expect(t.installs()).toBe(1)
    expect(t.vm.files.get(SCRIPTS_STAMP_PATH)).toBe(`${VM_SCRIPTS_STAMP}\n`)
  })

  it('installs on an equal stamp without the marker, then skips once the marker for these scripts is there', async () => {
    const t = await box({ [SCRIPTS_STAMP_PATH]: `${VM_SCRIPTS_STAMP}\n` })
    await ensureEntryPoints({ provider: t.vercel }, t.sessionId)
    expect(t.installs()).toBe(1)
    await ensureEntryPoints({ provider: t.vercel }, t.sessionId)
    expect(t.installs()).toBe(1)
  })

  it('skips on the matching marker even when the image stamp is older', async () => {
    const t = await box({ [SCRIPTS_STAMP_PATH]: '1\n', [marker]: '' })
    await ensureEntryPoints({ provider: t.vercel }, t.sessionId)
    expect(t.installs()).toBe(0)
  })

  it('installs when the probe cannot be read (as before stamps)', async () => {
    const t = await box({ [SCRIPTS_STAMP_PATH]: `${VM_SCRIPTS_STAMP + 1}\n` })
    t.vercel.commandHandler = (params) =>
      params.args?.[1]?.includes('echo marker=1') ? { exitCode: 1, stdout: '', stderr: 'boom' } : undefined
    await ensureEntryPoints({ provider: t.vercel }, t.sessionId)
    expect(t.installs()).toBe(1)
  })
})
