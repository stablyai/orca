import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KeybindingOverrides } from '../../shared/keybindings'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { pluginManifestSchema, type PluginManifest } from '../../shared/plugins/plugin-manifest'
import type { PluginWorkerHandle } from './plugin-host-process'
import { PluginService } from './plugin-service'
import type { PluginWorkerFactory } from './plugin-worker-manager'
import { hashPluginTree } from './plugin-content-hash'

const roots: string[] = []
const services: PluginService[] = []
const pluginKey = 'orca-samples.demo'

function manifest(options: { main?: string; capabilities?: PluginManifest['capabilities'] } = {}) {
  return pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'demo',
    publisher: 'orca-samples',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    main: options.main ?? 'worker.js',
    contributes: {
      panels: [{ id: 'panel', title: 'Panel', entry: 'panel.html' }],
      commands: [{ id: 'run', title: 'Run' }],
      events: []
    },
    capabilities: options.capabilities ?? []
  })
}

async function pluginRoot(pluginManifest = manifest()): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-reconcile-'))
  roots.push(root)
  await writeFile(join(root, 'orca-plugin.json'), JSON.stringify(pluginManifest))
  await writeFile(join(root, 'worker.js'), 'export default async function () {}')
  await writeFile(join(root, 'worker-v2.js'), 'export default async function () {}')
  await writeFile(join(root, 'panel.html'), '<h1>Panel</h1>')
  return root
}

function testWorker(): PluginWorkerHandle & { dispose: ReturnType<typeof vi.fn> } {
  return {
    commands: ['run'],
    invokeCommand: vi.fn(async () => null),
    deliverEvent: vi.fn(),
    lastActivityAt: () => Date.now(),
    inFlightCount: () => 0,
    dispose: vi.fn(async () => undefined),
    kill: vi.fn(),
    onExit: vi.fn()
  }
}

function createHarness(root: string) {
  let enabled = true
  let disabled: string[] = []
  let devPaths = [root]
  let killed = false
  const consent = fingerprintPluginConsent(manifest())
  const workers: ReturnType<typeof testWorker>[] = []
  const factory = vi.fn<PluginWorkerFactory>(async () => {
    const handle = testWorker()
    workers.push(handle)
    return handle
  })
  const service = new PluginService({
    userDataPath: root,
    hostVersion: '1.4.0',
    isPluginSystemEnabled: () => enabled,
    getDisabledPlugins: () => disabled,
    getPluginConsents: () => ({ [pluginKey]: consent }),
    getDevPluginPaths: () => devPaths,
    getPluginKillListEntry: (key) =>
      killed && key === pluginKey
        ? { pluginKey, reason: 'Security incident', advisoryUrl: 'https://orca.example/advisory' }
        : null,
    workerFactory: factory
  })
  services.push(service)
  return {
    service,
    factory,
    workers,
    setEnabled: (value: boolean) => {
      enabled = value
    },
    setDisabled: (value: string[]) => {
      disabled = value
    },
    setDevPaths: (value: string[]) => {
      devPaths = value
    },
    setKilled: (value: boolean) => {
      killed = value
    }
  }
}

async function activate(service: PluginService): Promise<void> {
  await service.initialize()
  await service.invokeCommand(pluginKey, 'run')
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PluginService worker reconciliation', () => {
  it('blocks every runtime surface until a saved override resolves a content conflict', async () => {
    const conflictingManifest = (id: string): PluginManifest =>
      pluginManifestSchema.parse({
        manifestVersion: 1,
        id,
        publisher: 'orca-samples',
        name: id,
        version: '1.0.0',
        engines: { orca: '>=1.0.0' },
        pluginApi: 1,
        main: 'worker.js',
        contributes: {
          panels: [{ id: 'panel', title: 'Panel', entry: 'panel.html' }],
          commands: [{ id: 'run', title: 'Run' }],
          keybindings: [{ command: 'run', key: 'Mod+Alt+T' }],
          events: [{ on: 'worktree.created' }]
        },
        capabilities: [{ kind: 'events:subscribe' }]
      })
    const firstManifest = conflictingManifest('first')
    const secondManifest = conflictingManifest('second')
    const firstRoot = await pluginRoot(firstManifest)
    const secondRoot = await pluginRoot(secondManifest)
    const firstHash = await hashPluginTree(firstRoot)
    const secondHash = await hashPluginTree(secondRoot)
    if (!firstHash.ok || !secondHash.ok) {
      throw new Error('could not hash conflict fixtures')
    }
    let keybindings: KeybindingOverrides = {}
    const factory = vi.fn<PluginWorkerFactory>(async () => testWorker())
    const service = new PluginService({
      userDataPath: firstRoot,
      hostVersion: '1.4.0',
      isPluginSystemEnabled: () => true,
      getDisabledPlugins: () => [],
      getPluginConsents: () => ({
        'orca-samples.first': fingerprintPluginConsent(firstManifest, firstHash.hash),
        'orca-samples.second': fingerprintPluginConsent(secondManifest, secondHash.hash)
      }),
      getDevPluginPaths: () => [firstRoot, secondRoot],
      getKeybindings: () => keybindings,
      workerFactory: factory
    })
    services.push(service)

    await service.initialize()

    expect(service.activationError('orca-samples.first')).toContain('conflicts')
    expect(service.getGrantedCapabilities('orca-samples.first')).toBeNull()
    await expect(service.invokeCommand('orca-samples.first', 'run')).rejects.toThrow('not enabled')
    await expect(service.panels.readEntry('orca-samples.first', 'panel')).resolves.toBeNull()
    service.emitEvent('worktree.created', {
      worktreeId: 'worktree-1',
      path: '/repo',
      branch: 'feature'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(factory).not.toHaveBeenCalled()

    keybindings = { 'plugin:orca-samples.first/run': ['Mod+Shift+T'] }
    await service.reconcileActivationState()

    expect(service.activationError('orca-samples.first')).toBeNull()
    await expect(service.panels.readEntry('orca-samples.first', 'panel')).resolves.toMatchObject({
      html: expect.stringContaining('<h1>Panel</h1>')
    })
    await expect(service.invokeCommand('orca-samples.first', 'run')).resolves.toBeNull()
    expect(factory).toHaveBeenCalledOnce()
  })

  it('rejects declarative aliases at the worker-command boundary without activating code', async () => {
    const aliasManifest = pluginManifestSchema.parse({
      manifestVersion: 1,
      id: 'demo',
      publisher: 'orca-samples',
      name: 'Demo',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: {
        commands: [{ id: 'tasks', title: 'Tasks', action: 'view.tasks' }]
      },
      capabilities: []
    })
    const root = await pluginRoot(aliasManifest)
    const factory = vi.fn<PluginWorkerFactory>()
    const service = new PluginService({
      userDataPath: root,
      hostVersion: '1.4.0',
      isPluginSystemEnabled: () => true,
      getDisabledPlugins: () => [],
      getPluginConsents: () => ({ [pluginKey]: fingerprintPluginConsent(aliasManifest) }),
      getDevPluginPaths: () => [root],
      workerFactory: factory
    })
    services.push(service)

    await service.initialize()

    await expect(service.invokeCommand(pluginKey, 'tasks')).rejects.toThrow(
      'is a built-in action alias'
    )
    expect(factory).not.toHaveBeenCalled()
  })

  it('denies every authority boundary immediately when the feature flag turns off', async () => {
    const root = await pluginRoot()
    const harness = createHarness(root)
    await activate(harness.service)
    const plugin = harness.service.findValidPlugin(pluginKey)!
    const opened = await harness.service.panels.open('renderer:1', pluginKey, 'panel')
    expect(opened).not.toBeNull()

    harness.setEnabled(false)

    expect(harness.service.activationState(plugin)).toBe('disabled')
    expect(harness.service.getGrantedCapabilities(pluginKey)).toBeNull()
    await expect(harness.service.invokeCommand(pluginKey, 'run')).rejects.toThrow('not enabled')
    await expect(harness.service.panels.readEntry(pluginKey, 'panel')).resolves.toBeNull()

    await harness.service.refresh()
    expect(harness.workers[0]!.dispose).toHaveBeenCalledOnce()
    harness.setEnabled(true)
    await harness.service.refresh()
    await expect(
      harness.service.panels.execute('renderer:1', {
        sessionToken: opened!.sessionToken,
        action: 'notifications.show',
        params: { title: 'stale' }
      })
    ).resolves.toMatchObject({ ok: false, error: 'invalid panel session' })
  })

  it('deactivates a worker when its plugin becomes disabled', async () => {
    const root = await pluginRoot()
    const harness = createHarness(root)
    await activate(harness.service)

    harness.setDisabled([pluginKey])
    await harness.service.refresh()

    expect(harness.workers[0]!.dispose).toHaveBeenCalledOnce()
    expect(harness.service.workerState(pluginKey).state).toBe('inactive')
  })

  it('immediately revokes every authority surface and stops a killed plugin', async () => {
    const root = await pluginRoot()
    const harness = createHarness(root)
    await activate(harness.service)
    expect(await harness.service.panels.open('renderer:1', pluginKey, 'panel')).not.toBeNull()

    harness.setKilled(true)

    expect(harness.service.getGrantedCapabilities(pluginKey)).toBeNull()
    expect(harness.service.activationError(pluginKey)).toContain('Security incident')
    await expect(harness.service.invokeCommand(pluginKey, 'run')).rejects.toThrow('not enabled')
    await expect(harness.service.panels.readEntry(pluginKey, 'panel')).resolves.toBeNull()
    harness.service.emitEvent('worktree.created', {
      worktreeId: 'worktree-1',
      path: '/repo',
      branch: 'feature'
    })
    await harness.service.reconcileActivationState()

    expect(harness.workers[0]!.dispose).toHaveBeenCalledOnce()
    expect(harness.service.options.getPluginKillListEntry?.(pluginKey)).toMatchObject({
      reason: 'Security incident'
    })
  })

  it('deactivates a worker when changed capabilities make consent pending', async () => {
    const root = await pluginRoot()
    const harness = createHarness(root)
    await activate(harness.service)
    await writeFile(
      join(root, 'orca-plugin.json'),
      JSON.stringify(manifest({ capabilities: [{ kind: 'storage' }] }))
    )

    await harness.service.refresh()

    expect(harness.workers[0]!.dispose).toHaveBeenCalledOnce()
    expect(harness.service.activationState(harness.service.findValidPlugin(pluginKey)!)).toBe(
      'pending'
    )
  })

  it('cancels the old generation when a worker spec changes without eager reactivation', async () => {
    const root = await pluginRoot()
    const harness = createHarness(root)
    await activate(harness.service)
    await writeFile(
      join(root, 'orca-plugin.json'),
      JSON.stringify(manifest({ main: 'worker-v2.js' }))
    )

    await harness.service.refresh()

    expect(harness.workers[0]!.dispose).toHaveBeenCalledOnce()
    expect(harness.factory).toHaveBeenCalledTimes(1)
    await harness.service.invokeCommand(pluginKey, 'run')
    expect(harness.factory).toHaveBeenCalledTimes(2)
    expect(harness.factory.mock.calls[1]?.[0].mainEntry).toBe('worker-v2.js')
  })

  it('cannot reactivate the old revision while refresh awaits worker shutdown', async () => {
    const root = await pluginRoot()
    let finishOldDispose!: () => void
    const oldDispose = new Promise<void>((resolve) => {
      finishOldDispose = resolve
    })
    const workers: ReturnType<typeof testWorker>[] = []
    const factory = vi.fn<PluginWorkerFactory>(async () => {
      const handle = testWorker()
      if (workers.length === 0) {
        handle.dispose.mockImplementation(() => oldDispose)
      }
      workers.push(handle)
      return handle
    })
    const consent = fingerprintPluginConsent(manifest())
    const service = new PluginService({
      userDataPath: root,
      hostVersion: '1.4.0',
      isPluginSystemEnabled: () => true,
      getDisabledPlugins: () => [],
      getPluginConsents: () => ({ [pluginKey]: consent }),
      getDevPluginPaths: () => [root],
      workerFactory: factory
    })
    services.push(service)
    await activate(service)
    await writeFile(
      join(root, 'orca-plugin.json'),
      JSON.stringify(manifest({ main: 'worker-v2.js' }))
    )

    const refreshing = service.refresh()
    await vi.waitFor(() => expect(workers[0]!.dispose).toHaveBeenCalledOnce())
    const invoking = service.invokeCommand(pluginKey, 'run')
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
    expect(factory.mock.calls[1]?.[0].mainEntry).toBe('worker-v2.js')
    finishOldDispose()

    await expect(invoking).resolves.toBeNull()
    await refreshing
  })

  it('deactivates removed and replaced dev paths without eager activation', async () => {
    const firstRoot = await pluginRoot()
    const secondRoot = await pluginRoot()
    const harness = createHarness(firstRoot)
    await activate(harness.service)

    harness.setDevPaths([])
    await harness.service.refresh()
    expect(harness.workers[0]!.dispose).toHaveBeenCalledOnce()
    expect(harness.service.findValidPlugin(pluginKey)).toBeNull()

    harness.setDevPaths([secondRoot])
    await harness.service.refresh()
    expect(harness.factory).toHaveBeenCalledTimes(1)
    await harness.service.invokeCommand(pluginKey, 'run')
    expect(harness.factory.mock.calls[1]?.[0].rootDir).toBe(secondRoot)
  })

  it('starts and stops housekeeping on feature-flag transitions', async () => {
    vi.useFakeTimers()
    const root = await pluginRoot()
    const harness = createHarness(root)
    await harness.service.initialize()
    expect(vi.getTimerCount()).toBe(1)

    harness.setEnabled(false)
    await harness.service.refresh()
    expect(vi.getTimerCount()).toBe(0)
    expect(harness.service.getDiscovered()).toEqual([])

    harness.setEnabled(true)
    await harness.service.refresh()
    expect(vi.getTimerCount()).toBe(1)
    expect(harness.factory).not.toHaveBeenCalled()
  })

  it('serializes activation reconciliation so the latest disabled state wins', async () => {
    const root = await pluginRoot()
    const harness = createHarness(root)
    await harness.service.initialize()

    const originalReconcile = harness.service.contentPacks.reconcile.bind(
      harness.service.contentPacks
    )
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstStarted!: () => void
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    let activeReconciliations = 0
    let maximumConcurrentReconciliations = 0
    let callCount = 0
    const reconcile = vi
      .spyOn(harness.service.contentPacks, 'reconcile')
      .mockImplementation(async (...args) => {
        callCount += 1
        activeReconciliations += 1
        maximumConcurrentReconciliations = Math.max(
          maximumConcurrentReconciliations,
          activeReconciliations
        )
        try {
          if (callCount === 1) {
            firstStarted()
            await firstGate
          }
          await originalReconcile(...args)
        } finally {
          activeReconciliations -= 1
        }
      })

    const first = harness.service.reconcileActivationState()
    await firstStartedPromise
    harness.setDisabled([pluginKey])
    const second = harness.service.reconcileActivationState()
    let clientsReleased = false
    const clientsReady = harness.service.whenReady().then(() => {
      clientsReleased = true
    })

    await Promise.resolve()
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(clientsReleased).toBe(false)
    releaseFirst()
    await Promise.all([first, second, clientsReady])

    expect(maximumConcurrentReconciliations).toBe(1)
    expect(clientsReleased).toBe(true)
    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(harness.service.activationState(harness.service.findValidPlugin(pluginKey)!)).toBe(
      'disabled'
    )
    expect(harness.service.workerState(pluginKey).state).toBe('inactive')
  })
})
