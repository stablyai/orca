import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import { OrcaRuntimeService } from '../../orca-runtime'
import { AI_VAULT_METHODS } from './ai-vault'
import { fakeSearchService } from '../../../../shared/ai-vault-search-test-fixture'
import { createSessionSearchClient } from '../../../../shared/ai-vault-search-client'
import { setSessionSearchService } from '../../../ai-vault-search/session-search-service-registry'

afterEach(() => setSessionSearchService(null))

function dispatcher(legacy = false) {
  return new RpcDispatcher({
    runtime: new OrcaRuntimeService(),
    methods: legacy ? [] : AI_VAULT_METHODS
  })
}

const request = (params: unknown) => ({
  id: 'search-1',
  authToken: 'test',
  method: 'aiVault.searchSessions',
  params
})

describe('session search runtime RPC', () => {
  it('returns typed unavailable and rejects invalid requests before the service', async () => {
    const rpc = dispatcher()
    expect(await rpc.dispatch(request({ query: 'needle' }))).toMatchObject({
      ok: true,
      result: { kind: 'unavailable', reason: 'no-service' }
    })
    const service = fakeSearchService()
    setSessionSearchService(service)
    expect(await rpc.dispatch(request({ query: 5 }))).toMatchObject({ ok: false })
    expect(service.search).not.toHaveBeenCalled()
  })
  it.each([undefined, 'runtime', 'mobile'] as const)(
    'applies exposure for authenticated client kind %s',
    async (clientKind) => {
      const service = fakeSearchService()
      setSessionSearchService(service)
      const rpc = dispatcher()
      const response = await rpc.dispatch(
        request({ query: 'needle', tier: 'conversation', refresh: true, clientKind: undefined }),
        { clientKind }
      )
      expect(response.ok).toBe(true)
      if (!response.ok) {
        throw new Error('Expected successful RPC')
      }
      const text = JSON.stringify(response.result)
      expect(text.includes('/host/transcript.jsonl')).toBe(clientKind === undefined)
      expect(text.includes('resumeCommand')).toBe(clientKind === undefined)
      expect(service.search).toHaveBeenCalledExactlyOnceWith(
        { query: 'needle', limit: 20 },
        undefined
      )
      const status = await rpc.dispatch(
        { ...request({}), method: 'aiVault.searchStatus' },
        { clientKind }
      )
      expect(status).toMatchObject({ ok: true, result: { enabled: true, generation: 7 } })
    }
  )
  it('maps the old runtime dispatcher refusal and rejects malformed responses', async () => {
    const legacy = dispatcher(true)
    const client = createSessionSearchClient(async (method, params) => {
      const response = await legacy.dispatch({ ...request(params), method })
      if (!response.ok) {
        throw Object.assign(new Error(response.error.message), { code: response.error.code })
      }
      return response.result
    }, 'relay')
    expect(await client.searchSessions({ query: 'needle' })).toEqual({
      kind: 'unavailable',
      reason: 'no-service'
    })
    const broken = createSessionSearchClient(async () => ({ kind: 'results', hits: [] }), 'runtime')
    await expect(broken.searchSessions({ query: 'needle' })).rejects.toThrow()
  })
})

describe('session search consent over the runtime RPC', () => {
  const enableRequest = (params: unknown) => ({
    id: 'enable-1',
    authToken: 'test',
    method: 'aiVault.setSearchEnabled',
    params
  })

  function consentDispatcher(runtime = new OrcaRuntimeService()) {
    const setSessionSearchEnabled = vi.fn(async () => {})
    // Overrides the surface-installed method, which proves it is there to override.
    Object.assign(runtime, { setSessionSearchEnabled })
    const dispatcher = new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })
    // Why the streaming entry point: `pairedDeviceId` only reaches a handler through it, and
    // it is the one the WebSocket transport a paired client connects over actually calls.
    const call = async (
      params: unknown,
      options?: { pairedDeviceId?: string; clientKind?: 'runtime' | 'mobile' }
    ): Promise<{ ok: boolean; result?: unknown; error?: { code: string } }> => {
      let raw = ''
      await dispatcher.dispatchStreaming(
        enableRequest(params),
        (response) => {
          raw = response
        },
        options
      )
      return JSON.parse(raw)
    }
    return { setSessionSearchEnabled, call }
  }

  it('refuses an in-process caller and never touches the setting', async () => {
    const { call, setSessionSearchEnabled } = consentDispatcher()
    expect(await call({ enabled: true })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' }
    })
    expect(setSessionSearchEnabled).not.toHaveBeenCalled()
  })

  it('applies a paired change and answers with this host status', async () => {
    setSessionSearchService(fakeSearchService())
    const { call, setSessionSearchEnabled } = consentDispatcher()
    const response = await call(
      { enabled: true },
      { pairedDeviceId: 'device-7', clientKind: 'runtime' }
    )

    expect(setSessionSearchEnabled).toHaveBeenCalledExactlyOnceWith(true)
    expect(response).toMatchObject({ ok: true, result: { enabled: true, generation: 7 } })
  })

  it('withholds host roots from a paired client, as searchStatus does', async () => {
    setSessionSearchService({
      ...fakeSearchService(),
      status: async () => ({
        enabled: true,
        phase: 'degraded' as const,
        filesIndexed: 0,
        filesDue: 0,
        filesFailed: 1,
        degradedRoots: [{ root: '/Users/someone/.claude', reason: 'unreadable' }],
        lastReconcileAt: null,
        lastSweepCompletedAt: null,
        generation: 3
      })
    })
    const { call } = consentDispatcher()
    const response = await call(
      { enabled: false },
      { pairedDeviceId: 'device-7', clientKind: 'runtime' }
    )

    expect(JSON.stringify(response)).not.toContain('/Users/someone/.claude')
  })

  it('reports the host refusal when this runtime has no settings store', async () => {
    const runtime = new OrcaRuntimeService()
    const dispatcher = new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })
    let raw = ''
    await dispatcher.dispatchStreaming(
      enableRequest({ enabled: true }),
      (response) => {
        raw = response
      },
      { pairedDeviceId: 'device-7', clientKind: 'runtime' }
    )
    expect(JSON.parse(raw)).toMatchObject({
      ok: false,
      error: { code: 'runtime_unavailable' }
    })
  })

  it('rejects a non-boolean before reaching the runtime', async () => {
    const { call, setSessionSearchEnabled } = consentDispatcher()
    expect(await call({ enabled: 'yes' }, { pairedDeviceId: 'device-7' })).toMatchObject({
      ok: false
    })
    expect(setSessionSearchEnabled).not.toHaveBeenCalled()
  })
})
