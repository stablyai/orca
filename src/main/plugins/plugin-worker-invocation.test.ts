import { describe, expect, it, vi } from 'vitest'
import { parsePluginManifest } from '../../shared/plugins/plugin-manifest'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginWorkerHandle } from './plugin-host-process'
import { invokePluginTaskSource, invokePluginWorkerCommand } from './plugin-worker-invocation'

const PLUGIN_KEY = 'orca-samples.tasks'

function plugin(
  capabilities: { kind: 'tasks:provide' }[] = [{ kind: 'tasks:provide' }]
): ValidDiscoveredPlugin {
  const parsed = parsePluginManifest({
    manifestVersion: 1,
    id: 'tasks',
    publisher: 'orca-samples',
    name: 'Tasks',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    main: 'worker.js',
    contributes: {
      commands: [{ id: 'run', title: 'Run' }],
      taskSources: [{ id: 'roadmap', title: 'Roadmap' }]
    },
    capabilities: [{ kind: 'tasks:provide' }]
  })
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  return {
    pluginKey: PLUGIN_KEY,
    rootDir: '/plugin',
    // Why: a manifest lacking the capability cannot parse, so models a validation gap.
    manifest: { ...parsed.manifest, capabilities },
    consentFingerprint: 'sha256-current',
    contentHash: null,
    isDev: true
  }
}

function worker(value: unknown, taskSources = ['roadmap']): PluginWorkerHandle {
  return {
    commands: ['run'],
    invokeCommand: vi.fn(async () => 'ran'),
    taskSources,
    invokeTaskSource: vi.fn(async () => value),
    deliverEvent: vi.fn(),
    lastActivityAt: () => Date.now(),
    inFlightCount: () => 0,
    dispose: vi.fn(async () => undefined),
    kill: vi.fn(),
    onExit: vi.fn()
  }
}

function deps(
  handle: PluginWorkerHandle,
  options: { enabled?: boolean; subject?: ValidDiscoveredPlugin } = {}
) {
  const subject = options.subject ?? plugin()
  return {
    findStartablePlugin: (pluginKey: string) =>
      options.enabled === false || pluginKey !== PLUGIN_KEY ? null : subject,
    ensureWorker: vi.fn(async () => handle)
  }
}

const listRequest = {
  pluginKey: PLUGIN_KEY,
  sourceId: 'roadmap',
  operation: 'list',
  params: { query: 'calibration' }
}

describe('invokePluginTaskSource', () => {
  it('fills list defaults and returns the validated result', async () => {
    const handle = worker({
      items: [{ id: 'a', title: 'Plan A', status: { label: 'Open', tone: 'open' } }]
    })

    const result = await invokePluginTaskSource(deps(handle), listRequest)

    expect(handle.invokeTaskSource).toHaveBeenCalledWith('roadmap', 'list', {
      query: 'calibration',
      filters: {}
    })
    expect(result).toEqual({
      items: [{ id: 'a', title: 'Plan A', status: { label: 'Open', tone: 'open' } }]
    })
  })

  it('rejects a worker result that does not match the contract', async () => {
    const handle = worker({ items: [{ id: 'a', title: 'Plan A', surprise: true }] })

    await expect(invokePluginTaskSource(deps(handle), listRequest)).rejects.toThrow(
      'returned an invalid list result'
    )
  })

  it('rejects a non-http item url', async () => {
    const handle = worker({ item: { id: 'a', title: 'A', url: 'file:///etc/passwd' } })

    await expect(
      invokePluginTaskSource(deps(handle), {
        pluginKey: PLUGIN_KEY,
        sourceId: 'roadmap',
        operation: 'get',
        params: { itemId: 'a' }
      })
    ).rejects.toThrow('item.url')
  })

  it('refuses disabled plugins, undeclared sources and missing consent before starting a worker', async () => {
    const handle = worker({ items: [] })
    const disabled = deps(handle, { enabled: false })
    const unconsented = deps(handle, { subject: plugin([]) })
    const undeclared = deps(handle)

    await expect(invokePluginTaskSource(disabled, listRequest)).rejects.toThrow('not enabled')
    await expect(invokePluginTaskSource(unconsented, listRequest)).rejects.toThrow(
      'not allowed to provide tasks'
    )
    await expect(
      invokePluginTaskSource(undeclared, { ...listRequest, sourceId: 'other' })
    ).rejects.toThrow('does not contribute task source other')
    expect(disabled.ensureWorker).not.toHaveBeenCalled()
    expect(unconsented.ensureWorker).not.toHaveBeenCalled()
    expect(undeclared.ensureWorker).not.toHaveBeenCalled()
  })

  it('refuses a declared source the worker never registered', async () => {
    const handle = worker({ items: [] }, [])

    await expect(invokePluginTaskSource(deps(handle), listRequest)).rejects.toThrow(
      'registered no handler'
    )
  })

  it('rejects malformed requests', async () => {
    const handle = worker({ items: [] })

    await expect(
      invokePluginTaskSource(deps(handle), { ...listRequest, operation: 'delete' })
    ).rejects.toThrow()
    await expect(
      invokePluginTaskSource(deps(handle), {
        ...listRequest,
        params: { filters: { 'Bad Key': 'x' } }
      })
    ).rejects.toThrow()
  })
})

describe('invokePluginWorkerCommand', () => {
  it('runs a declared command the worker registered', async () => {
    const handle = worker(null)

    await expect(
      invokePluginWorkerCommand(deps(handle), PLUGIN_KEY, 'run', { a: 1 })
    ).resolves.toBe('ran')
    expect(handle.invokeCommand).toHaveBeenCalledWith('run', { a: 1 })
  })

  it('refuses disabled plugins and undeclared commands before starting a worker', async () => {
    const handle = worker(null)
    const disabled = deps(handle, { enabled: false })
    const undeclared = deps(handle)

    await expect(invokePluginWorkerCommand(disabled, PLUGIN_KEY, 'run')).rejects.toThrow(
      'not enabled'
    )
    await expect(invokePluginWorkerCommand(undeclared, PLUGIN_KEY, 'nope')).rejects.toThrow(
      'does not contribute command nope'
    )
    expect(disabled.ensureWorker).not.toHaveBeenCalled()
    expect(undeclared.ensureWorker).not.toHaveBeenCalled()
  })
})
