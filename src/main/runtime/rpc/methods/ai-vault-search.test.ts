import { afterEach, describe, expect, it } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { AI_VAULT_METHODS } from './ai-vault'
import { fakeSearchService } from '../../../../shared/ai-vault-search-test-fixture'
import { createSessionSearchClient } from '../../../../shared/ai-vault-search-client'
import { setSessionSearchService } from '../../../ai-vault-search/session-search-service-registry'

afterEach(() => setSessionSearchService(null))

function dispatcher(legacy = false) {
  return new RpcDispatcher({
    runtime: { getRuntimeId: () => 'owning-host' } as OrcaRuntimeService,
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
      expect(service.search).toHaveBeenCalledExactlyOnceWith({ query: 'needle', limit: 20 })
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
