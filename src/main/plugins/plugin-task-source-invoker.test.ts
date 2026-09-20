import { describe, expect, it, vi } from 'vitest'
import { invokePluginTaskSourceMethod } from './plugin-task-source-invoker'
import { PluginTaskSourceRegistry } from './plugin-task-source-registry'
import { pluginTaskPageSchema } from '../../shared/plugins/plugin-task-source-contract'
import type { DiscoveredPlugin } from './plugin-discovery'

function registryWithBoards(): PluginTaskSourceRegistry {
  const registry = new PluginTaskSourceRegistry()
  registry.reconcile(
    [
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the
      // registry reads only pluginKey and contributes.taskSources.
      {
        pluginKey: 'acme.boards',
        rootDir: '/plugins/acme.boards',
        manifest: {
          main: 'main.mjs',
          contributes: { taskSources: [{ id: 'azure-boards', title: 'Azure Boards' }] }
        }
      } as unknown as DiscoveredPlugin
    ],
    () => true
  )
  return registry
}

describe('invokePluginTaskSourceMethod', () => {
  it('returns validated data on success', async () => {
    const result = await invokePluginTaskSourceMethod({
      registry: registryWithBoards(),
      callWorker: async () => ({ ok: true, data: { items: [], nextCursor: null } }),
      pluginKey: 'acme.boards',
      sourceId: 'azure-boards',
      method: 'listItems',
      params: { scopeIds: [], search: null, cursor: null, limit: 50 },
      resultSchema: pluginTaskPageSchema
    })

    expect(result).toEqual({ ok: true, data: { items: [], nextCursor: null } })
  })

  it('reports an unregistered source as not_found without calling the worker', async () => {
    const callWorker = vi.fn()

    const result = await invokePluginTaskSourceMethod({
      registry: registryWithBoards(),
      callWorker,
      pluginKey: 'acme.boards',
      sourceId: 'missing',
      method: 'listItems',
      params: {},
      resultSchema: pluginTaskPageSchema
    })

    expect(result).toMatchObject({ ok: false, code: 'not_found' })
    expect(callWorker).not.toHaveBeenCalled()
  })

  it('maps a worker rejection to unavailable, never to empty data', async () => {
    const result = await invokePluginTaskSourceMethod({
      registry: registryWithBoards(),
      callWorker: async () => {
        throw new Error('worker exited')
      },
      pluginKey: 'acme.boards',
      sourceId: 'azure-boards',
      method: 'listItems',
      params: {},
      resultSchema: pluginTaskPageSchema
    })

    expect(result).toMatchObject({ ok: false, code: 'unavailable' })
  })

  it('maps a malformed worker payload to unavailable', async () => {
    const result = await invokePluginTaskSourceMethod({
      registry: registryWithBoards(),
      callWorker: async () => ({ ok: true, data: { items: 'not-an-array' } }),
      pluginKey: 'acme.boards',
      sourceId: 'azure-boards',
      method: 'listItems',
      params: {},
      resultSchema: pluginTaskPageSchema
    })

    expect(result).toMatchObject({ ok: false, code: 'unavailable' })
  })

  it('passes a plugin-reported failure code through unchanged', async () => {
    const result = await invokePluginTaskSourceMethod({
      registry: registryWithBoards(),
      callWorker: async () => ({ ok: false, code: 'unauthorized', message: 'token expired' }),
      pluginKey: 'acme.boards',
      sourceId: 'azure-boards',
      method: 'listItems',
      params: {},
      resultSchema: pluginTaskPageSchema
    })

    expect(result).toEqual({ ok: false, code: 'unauthorized', message: 'token expired' })
  })
})
