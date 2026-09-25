import { describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginWorkerHandle } from './plugin-host-process'
import {
  invokePluginWorkerTaskSource,
  type PluginWorkerInvocationHost
} from './plugin-worker-invocation'

function plugin(taskSourceIds: string[]): ValidDiscoveredPlugin {
  return {
    pluginKey: 'orca-samples.demo',
    rootDir: '/plugins/demo',
    manifest: pluginManifestSchema.parse({
      manifestVersion: 1,
      id: 'demo',
      publisher: 'orca-samples',
      name: 'Demo',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      main: 'main.mjs',
      contributes: {
        taskSources: taskSourceIds.map((id) => ({ id, title: `Title ${id}` }))
      },
      capabilities: []
    }),
    consentFingerprint: 'sha256-current',
    contentHash: null,
    isDev: true
  }
}

function host(options: {
  plugin: ValidDiscoveredPlugin | null
  registered?: string[]
  invokeTaskSource?: PluginWorkerHandle['invokeTaskSource']
}): PluginWorkerInvocationHost & { invokeTaskSource: PluginWorkerHandle['invokeTaskSource'] } {
  const invokeTaskSource = options.invokeTaskSource ?? vi.fn(async () => null)
  const handle: PluginWorkerHandle = {
    commands: [],
    taskSources: options.registered ?? [],
    invokeCommand: vi.fn(async () => null),
    invokeTaskSource,
    deliverEvent: vi.fn(),
    lastActivityAt: () => Date.now(),
    inFlightCount: () => 0,
    dispose: vi.fn(async () => undefined),
    kill: vi.fn(),
    onExit: vi.fn()
  }
  return {
    invokeTaskSource,
    resolveRunnablePlugin: () => options.plugin,
    ensureWorker: async () => handle
  }
}

const request = { sourceId: 'boards', method: 'status', params: null } as const

describe('invokePluginWorkerTaskSource', () => {
  it('delegates to the worker handle for a declared and registered source', async () => {
    const invokeTaskSource = vi.fn(async () => ({ ok: true, data: 'connected' }))
    const subject = host({ plugin: plugin(['boards']), registered: ['boards'], invokeTaskSource })

    const result = await invokePluginWorkerTaskSource(subject, {
      pluginKey: 'orca-samples.demo',
      ...request
    })

    expect(result).toEqual({ ok: true, data: 'connected' })
    expect(invokeTaskSource).toHaveBeenCalledWith('boards', 'status', null)
  })

  it('refuses a source the plugin cannot run at all', async () => {
    const subject = host({ plugin: null })

    await expect(
      invokePluginWorkerTaskSource(subject, { pluginKey: 'orca-samples.demo', ...request })
    ).rejects.toThrow('plugin orca-samples.demo is not enabled')
    expect(subject.invokeTaskSource).not.toHaveBeenCalled()
  })

  it('refuses a source the manifest never declared', async () => {
    const subject = host({ plugin: plugin(['issues']), registered: ['boards'] })

    await expect(
      invokePluginWorkerTaskSource(subject, { pluginKey: 'orca-samples.demo', ...request })
    ).rejects.toThrow('does not contribute task source boards')
    expect(subject.invokeTaskSource).not.toHaveBeenCalled()
  })

  it('refuses a declared source the worker registered no handler for', async () => {
    const subject = host({ plugin: plugin(['boards']), registered: [] })

    await expect(
      invokePluginWorkerTaskSource(subject, { pluginKey: 'orca-samples.demo', ...request })
    ).rejects.toThrow('registered no handler for boards')
    expect(subject.invokeTaskSource).not.toHaveBeenCalled()
  })
})
