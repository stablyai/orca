import { describe, expect, it, vi } from 'vitest'
import {
  invokeContributedTaskSource,
  invokePluginTaskSourceMethod
} from './plugin-task-source-invoker'
import { pluginTaskPageSchema } from '../../shared/plugins/plugin-task-source-contract'
import { createPluginActivationCoalescer } from './plugin-activation-coalescer'
import type { PluginTaskSourceProxy } from '../../shared/plugins/plugin-extension-registry'

async function invoke(callWorker: () => Promise<unknown>) {
  return invokePluginTaskSourceMethod({
    callWorker,
    pluginKey: 'acme.boards',
    sourceId: 'azure-boards',
    method: 'listItems',
    params: { scopeIds: [], search: null, cursor: null, limit: 50 },
    resultSchema: pluginTaskPageSchema
  })
}

describe('invokePluginTaskSourceMethod', () => {
  it('returns validated data on success', async () => {
    const result = await invoke(async () => ({ ok: true, data: { items: [], nextCursor: null } }))

    expect(result).toEqual({ ok: true, data: { items: [], nextCursor: null } })
  })

  it('maps a worker rejection to unavailable, never to empty data', async () => {
    const result = await invoke(async () => {
      throw new Error('worker exited')
    })

    expect(result).toMatchObject({ ok: false, code: 'unavailable' })
  })

  it('does not surface the worker error string in the user-facing envelope', async () => {
    const result = await invoke(async () => {
      throw new Error('at Object.<anonymous> (/plugins/acme.boards/main.js:42:9)')
    })

    expect(result).toMatchObject({ ok: false, code: 'unavailable' })
    expect('message' in result && result.message).not.toContain('main.js')
  })

  it('maps a malformed worker payload to unavailable', async () => {
    const result = await invoke(async () => ({ ok: true, data: { items: 'not-an-array' } }))

    expect(result).toMatchObject({ ok: false, code: 'unavailable' })
  })

  it('maps a worker payload that is not an envelope at all to unavailable', async () => {
    const result = await invoke(async () => ({ items: [], nextCursor: null }))

    expect(result).toMatchObject({ ok: false, code: 'unavailable' })
  })

  it('passes a plugin-reported failure code through unchanged', async () => {
    const result = await invoke(async () => ({
      ok: false,
      code: 'unauthorized',
      message: 'token expired'
    }))

    expect(result).toEqual({ ok: false, code: 'unauthorized', message: 'token expired' })
  })
})

describe('invokeContributedTaskSource', () => {
  it('rejects an unknown method with a validation envelope and never resolves a proxy or activates', async () => {
    const resolveProxy = vi.fn()
    const activate = vi.fn()

    const result = await invokeContributedTaskSource({
      resolveProxy,
      activate,
      pluginKey: 'acme.boards',
      sourceId: 'azure-boards',
      method: 'deleteEverything',
      params: {}
    })

    expect(result).toEqual({
      ok: false,
      code: 'validation',
      message: 'unknown task source method deleteEverything'
    })
    expect(resolveProxy).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()
  })

  it('returns the proxy envelope unchanged for a valid call without activating', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } })
    const resolveProxy = vi.fn().mockReturnValue({ sourceId: 'azure-boards', call })
    const activate = vi.fn()

    const result = await invokeContributedTaskSource({
      resolveProxy,
      activate,
      pluginKey: 'acme.boards',
      sourceId: 'azure-boards',
      method: 'listItems',
      params: { scopeIds: [], search: null, cursor: null, limit: 50 }
    })

    expect(result).toEqual({ ok: true, data: { items: [], nextCursor: null } })
    expect(call).toHaveBeenCalledWith('listItems', {
      scopeIds: [],
      search: null,
      cursor: null,
      limit: 50
    })
    expect(activate).not.toHaveBeenCalled()
  })

  it('accepts listFacetOptions and passes its facet and scope params to the proxy', async () => {
    const call = vi
      .fn()
      .mockResolvedValue({ ok: true, data: [{ id: 'sprint-42', label: 'Sprint 42' }] })
    const params = { facetId: 'sprint', scopeIds: ['org/proj'] }

    const result = await invokeContributedTaskSource({
      resolveProxy: vi.fn().mockReturnValue({ sourceId: 'azure-boards', call }),
      activate: vi.fn(),
      pluginKey: 'acme.boards',
      sourceId: 'azure-boards',
      method: 'listFacetOptions',
      params
    })

    expect(result).toEqual({ ok: true, data: [{ id: 'sprint-42', label: 'Sprint 42' }] })
    expect(call).toHaveBeenCalledWith('listFacetOptions', params)
  })

  it('reports unavailable, not a throw, when the pair still has no proxy after activation', async () => {
    const resolveProxy = vi.fn().mockReturnValue(null)
    const activate = vi.fn().mockResolvedValue(undefined)

    const result = await invokeContributedTaskSource({
      resolveProxy,
      activate,
      pluginKey: 'acme.boards',
      sourceId: 'missing-source',
      method: 'status',
      params: undefined
    })

    expect(result).toMatchObject({ ok: false, code: 'unavailable' })
    expect(activate).toHaveBeenCalledWith('acme.boards')
    expect(resolveProxy).toHaveBeenCalledTimes(2)
  })

  it('activates an idle plugin on a proxy miss and returns the data once registered', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } })
    const resolveProxy = vi
      .fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ sourceId: 'azure-boards', call })
    const activate = vi.fn().mockResolvedValue(undefined)

    const result = await invokeContributedTaskSource({
      resolveProxy,
      activate,
      pluginKey: 'acme.boards',
      sourceId: 'azure-boards',
      method: 'listItems',
      params: { scopeIds: [], search: null, cursor: null, limit: 50 }
    })

    expect(result).toEqual({ ok: true, data: { items: [], nextCursor: null } })
    expect(activate).toHaveBeenCalledOnce()
    expect(resolveProxy).toHaveBeenCalledTimes(2)
  })

  it('does not re-activate a plugin whose proxy already resolves', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } })
    const resolveProxy = vi.fn().mockReturnValue({ sourceId: 'azure-boards', call })
    const activate = vi.fn().mockResolvedValue(undefined)

    await invokeContributedTaskSource({
      resolveProxy,
      activate,
      pluginKey: 'acme.boards',
      sourceId: 'azure-boards',
      method: 'listItems',
      params: {}
    })

    expect(activate).not.toHaveBeenCalled()
    expect(resolveProxy).toHaveBeenCalledOnce()
  })

  it('maps an activation rejection to unavailable without rejecting the call', async () => {
    const resolveProxy = vi.fn().mockReturnValue(null)
    const activate = vi.fn().mockRejectedValue(new Error('plugin acme.boards is not approved'))

    const result = await invokeContributedTaskSource({
      resolveProxy,
      activate,
      pluginKey: 'acme.boards',
      sourceId: 'azure-boards',
      method: 'listItems',
      params: {}
    })

    expect(result).toMatchObject({ ok: false, code: 'unavailable' })
  })

  it('does not leak the activation error text into the returned envelope', async () => {
    const resolveProxy = vi.fn().mockReturnValue(null)
    const activate = vi
      .fn()
      .mockRejectedValue(new Error('at Object.<anonymous> (/plugins/acme.boards/main.js:42:9)'))

    const result = await invokeContributedTaskSource({
      resolveProxy,
      activate,
      pluginKey: 'acme.boards',
      sourceId: 'azure-boards',
      method: 'listItems',
      params: {}
    })

    expect(result).toMatchObject({ ok: false, code: 'unavailable' })
    expect(JSON.stringify(result)).not.toContain('main.js')
  })
})

/** An idle plugin: no proxy resolves until an activation has registered one. */
function idlePlugin(options: { activation?: () => Promise<void> } = {}) {
  let registered = false
  const proxy: PluginTaskSourceProxy = {
    sourceId: 'azure-boards',
    call: async (method) => ({ ok: true, data: { method } })
  }
  const resolveProxy = vi.fn((): PluginTaskSourceProxy | null => (registered ? proxy : null))
  const start = vi.fn(async () => {
    await (options.activation?.() ?? new Promise((resolve) => setTimeout(resolve, 5)))
    registered = true
  })
  return { resolveProxy, activate: createPluginActivationCoalescer(start).activate, start }
}

function callSource(host: ReturnType<typeof idlePlugin>, method: string) {
  return invokeContributedTaskSource({
    resolveProxy: host.resolveProxy,
    activate: host.activate,
    pluginKey: 'acme.boards',
    sourceId: 'azure-boards',
    method,
    params: {}
  })
}

describe('invokeContributedTaskSource against an idle plugin', () => {
  it('serves two concurrent calls from one activation', async () => {
    const host = idlePlugin()

    const [scopes, items] = await Promise.all([
      callSource(host, 'listScopes'),
      callSource(host, 'listItems')
    ])

    expect(scopes).toMatchObject({ ok: true })
    expect(items).toMatchObject({ ok: true })
    expect(host.start).toHaveBeenCalledOnce()
  })

  it('serves ten concurrent calls from one activation', async () => {
    const host = idlePlugin()

    const results = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        callSource(host, index % 2 === 0 ? 'listItems' : 'listScopes')
      )
    )

    expect(results.every((result) => result.ok)).toBe(true)
    expect(host.start).toHaveBeenCalledOnce()
  })

  it('makes a call arriving mid-activation wait for it instead of failing', async () => {
    const host = idlePlugin()

    const first = callSource(host, 'listScopes')
    await new Promise((resolve) => setTimeout(resolve, 1))
    const late = callSource(host, 'listItems')

    expect(await first).toMatchObject({ ok: true })
    expect(await late).toMatchObject({ ok: true })
    expect(host.start).toHaveBeenCalledOnce()
  })

  it('reports unavailable to every waiting caller when the shared activation fails', async () => {
    const host = idlePlugin({
      activation: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        throw new Error('at Object.<anonymous> (/plugins/acme.boards/main.js:42:9)')
      }
    })

    const results = await Promise.all([
      callSource(host, 'listScopes'),
      callSource(host, 'listItems')
    ])

    expect(results).toHaveLength(2)
    for (const result of results) {
      expect(result).toMatchObject({ ok: false, code: 'unavailable' })
      expect(JSON.stringify(result)).not.toContain('main.js')
    }
    expect(host.start).toHaveBeenCalledOnce()
  })

  it('short-circuits an unknown method to validation without joining an activation', async () => {
    const host = idlePlugin()

    const results = await Promise.all([
      callSource(host, 'deleteEverything'),
      callSource(host, 'dropDatabase')
    ])

    for (const result of results) {
      expect(result).toMatchObject({ ok: false, code: 'validation' })
    }
    expect(host.start).not.toHaveBeenCalled()
    expect(host.resolveProxy).not.toHaveBeenCalled()
  })
})
