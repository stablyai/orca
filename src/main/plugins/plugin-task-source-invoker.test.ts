import { describe, expect, it, vi } from 'vitest'
import { invokeContributedTaskSource, invokePluginTaskSourceMethod } from './plugin-task-source-invoker'
import { pluginTaskPageSchema } from '../../shared/plugins/plugin-task-source-contract'

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
