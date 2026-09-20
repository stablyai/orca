import { describe, expect, it } from 'vitest'
import { invokePluginTaskSourceMethod } from './plugin-task-source-invoker'
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
