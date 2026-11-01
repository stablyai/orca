import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePluginManifest } from '../../shared/plugins/manifest/plugin-manifest'
import { PLUGIN_EVENT_NAMES } from '../../shared/plugins/contributions/plugin-event-contribution'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { emitPluginDevEvent } from './plugin-dev-event-emit'
import type { PluginWorkerHandle } from './workers/plugin-host-process'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const CREATED = { workspaceId: 'wt-1', kind: 'worktree', path: '/repo', branch: 'main' }

function plugin(rootDir: string, raw: Record<string, unknown> = {}): ValidDiscoveredPlugin {
  const parsed = parsePluginManifest({
    manifestVersion: 2,
    id: 'demo',
    publisher: 'acme',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: '>=1.4.245' },
    execution: 'trusted-worker',
    pluginApi: 1,
    main: 'worker.js',
    contributes: { events: [{ on: 'workspace.created' }] },
    capabilities: [{ kind: 'workspace:read' }],
    ...raw
  })
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  return {
    pluginKey: 'acme.demo',
    rootDir,
    manifest: parsed.manifest,
    consentFingerprint: 'fp',
    consentContentHash: 'dev-identity',
    contentHash: null,
    isDev: true
  }
}

async function harness(options: { plugin?: ValidDiscoveredPlugin; approved?: boolean } = {}) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'orca-dev-emit-')))
  roots.push(folder)
  const target = options.plugin ?? plugin(folder)
  const deliverEvent = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dev emit only calls deliverEvent on the handle.
  const handle = { deliverEvent } as unknown as PluginWorkerHandle
  const ensureWorker = vi.fn(async () => handle)
  const service = {
    options: {
      isPluginSystemEnabled: () => true,
      getDevPluginPaths: () => [target.rootDir]
    },
    getDiscovered: () => [target],
    eventDelivery: {
      plugins: () => [target],
      ensureWorker,
      isRuntimeApproved: () => options.approved ?? true,
      grantedCapabilities: () => ['workspace:read' as const],
      logWarning: () => () => undefined
    }
  }
  const emit = (event: string, payload: unknown, pick?: { path: string } | { pluginKey: string }) =>
    emitPluginDevEvent({
      service,
      target: pick ?? { pluginKey: target.pluginKey },
      event,
      payload
    })
  return { folder, emit, deliverEvent, ensureWorker }
}

describe('emitPluginDevEvent', () => {
  it('starts the worker and delivers the projected payload, by key or folder', async () => {
    const { folder, emit, deliverEvent, ensureWorker } = await harness()
    await expect(emit('workspace.created', { ...CREATED, extra: 1 })).resolves.toEqual({
      pluginKey: 'acme.demo',
      event: 'workspace.created',
      delivered: { worker: true, panels: 0 }
    })
    expect(deliverEvent).toHaveBeenCalledWith('workspace.created', CREATED)
    await emit('worktree.created', CREATED, { path: folder })
    expect(ensureWorker).toHaveBeenCalledTimes(2)
    expect(deliverEvent).toHaveBeenLastCalledWith('workspace.created', CREATED)
  })

  it('refuses an installed plugin', async () => {
    const installed = { ...plugin('/plugins/acme.demo'), isDev: false }
    const { emit, ensureWorker } = await harness({ plugin: installed })
    await expect(emit('workspace.created', CREATED)).rejects.toThrow(/installed plugin/)
    expect(ensureWorker).not.toHaveBeenCalled()
  })

  it('lists the events when the name is unknown', async () => {
    const { emit } = await harness()
    await expect(emit('workspace.renamed', {})).rejects.toMatchObject({
      code: 'invalid_argument',
      data: { events: [...PLUGIN_EVENT_NAMES] }
    })
  })

  it('refuses data that does not match the payload schema', async () => {
    const { emit, ensureWorker } = await harness()
    await expect(emit('workspace.created', { workspaceId: 'wt-1' })).rejects.toMatchObject({
      code: 'invalid_argument',
      data: { issues: expect.arrayContaining([expect.stringMatching(/^kind: /)]) }
    })
    expect(ensureWorker).not.toHaveBeenCalled()
  })

  it('refuses an event the plugin does not subscribe to, or while it is not approved', async () => {
    const { emit } = await harness()
    await expect(
      emit('agent.status.changed', {
        workspaceId: null,
        paneKey: 'p',
        state: 'done',
        receivedAt: 1
      })
    ).rejects.toThrow(/does not subscribe to agent.status.changed/)
    const pending = await harness({ approved: false })
    await expect(pending.emit('workspace.created', CREATED)).rejects.toThrow(/not approved/)
    expect(pending.ensureWorker).not.toHaveBeenCalled()
  })
})
