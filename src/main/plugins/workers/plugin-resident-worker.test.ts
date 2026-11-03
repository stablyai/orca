import { describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import type { PluginWorkerHandle } from './plugin-host-process'
import { PluginWorkerManager } from './plugin-worker-manager'
import { buildPluginWorkerSpawnSpec } from './plugin-worker-spawn-spec'
import {
  createPluginResidentWorkerWarmer,
  pluginNeedsResidentWorker
} from './plugin-resident-worker'

function plugin(
  pluginKey: string,
  contributes: { statusBarItems?: { id: string }[]; hooks?: { event: string }[] },
  options: { main?: boolean; fingerprint?: string } = {}
): ValidDiscoveredPlugin {
  return {
    pluginKey,
    rootDir: `/plugins/${pluginKey}`,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 2,
      execution: options.main === false ? 'declarative' : 'trusted-worker',
      id: 'meter',
      name: 'Meter',
      version: '1.0.0',
      engines: { orca: '>=1.4.248' },
      ...(options.main === false ? {} : { main: 'main.mjs' }),
      contributes
    }),
    consentFingerprint: options.fingerprint ?? 'fp',
    contentHash: null,
    isDev: false
  }
}

function worker(): PluginWorkerHandle {
  return {
    commands: [],
    invokeCommand: vi.fn(),
    deliverEvent: vi.fn(),
    requestFromPanel: vi.fn(),
    runHook: vi.fn(),
    notifyDataChanged: vi.fn(),
    // Long idle on purpose: only keepWarm stops the reap.
    lastActivityAt: () => 0,
    inFlightCount: () => 0,
    dispose: vi.fn(async () => undefined),
    kill: vi.fn(),
    onExit: () => undefined
  }
}

const meter = { statusBarItems: [{ id: 'usage' }] }

describe('resident plugin workers', () => {
  it('needs a resident worker for hooks or status bar items, only with a worker entry', () => {
    expect(pluginNeedsResidentWorker(plugin('a', meter).manifest)).toBe(true)
    expect(
      pluginNeedsResidentWorker(plugin('a', { hooks: [{ event: 'terminal.send' }] }).manifest)
    ).toBe(true)
    expect(pluginNeedsResidentWorker(plugin('a', {}).manifest)).toBe(false)
    expect(pluginNeedsResidentWorker(plugin('a', meter, { main: false }).manifest)).toBe(false)
  })

  it('starts a status bar plugin once per approved revision while it is enabled', () => {
    let plugins = [plugin('acme.meter', meter), plugin('acme.plain', {})]
    const enabled = new Set(['acme.meter', 'acme.plain'])
    let systemEnabled = true
    const ensureWorker = vi.fn(async (_plugin: ValidDiscoveredPlugin) => worker())
    const warm = createPluginResidentWorkerWarmer({
      plugins: () => plugins,
      isRuntimeApproved: (candidate) => enabled.has(candidate.pluginKey),
      ensureWorker,
      isEnabled: () => systemEnabled
    })
    warm()
    warm()
    expect(ensureWorker.mock.calls.map(([started]) => started.pluginKey)).toEqual(['acme.meter'])

    plugins = [plugin('acme.meter', meter, { fingerprint: 'fp-2' })]
    warm()
    expect(ensureWorker).toHaveBeenCalledTimes(2)

    enabled.delete('acme.meter')
    warm()
    enabled.add('acme.meter')
    warm()
    expect(ensureWorker).toHaveBeenCalledTimes(3)

    systemEnabled = false
    warm()
    systemEnabled = true
    warm()
    expect(ensureWorker).toHaveBeenCalledTimes(4)
  })

  it('keeps a status bar plugin’s worker through idle reaping', async () => {
    const running = worker()
    const manager = new PluginWorkerManager({
      entryPath: '/host.js',
      workerFactory: vi.fn(async () => running),
      idleReapMs: 100,
      executeHostCall: async () => ({ ok: true, value: null }),
      log: () => vi.fn(),
      onWorkerStateChange: vi.fn()
    })
    const spec = buildPluginWorkerSpawnSpec(plugin('acme.meter', meter), [])
    expect(spec.keepWarm).toBe(true)
    expect(buildPluginWorkerSpawnSpec(plugin('acme.plain', {}), []).keepWarm).toBeUndefined()
    await manager.ensureActive(spec)

    manager.reapIdle(10_000)
    expect(running.dispose).not.toHaveBeenCalled()
    expect(manager.runningHandle('acme.meter')).toBe(running)
    await manager.disposeAll()
  })
})
