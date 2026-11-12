import { afterEach, expect, test } from 'vitest'
import { AI_VAULT_AGENTS } from '../../shared/ai-vault/contracts/ai-vault-types'
import {
  fakeSearchService,
  searchHit,
  searchResults
} from '../../shared/ai-vault/search/ai-vault-search-test-fixture'
import { searchSessionService, setSessionSearchService } from './session-search-service-registry'
import './query/session-search-page-cursor'

afterEach(() => setSessionSearchService(null))

test.each(['relay'] as const)(
  'keeps an empty decoder catalog authoritative over both history flags on %s',
  async (transport) => {
    const service = fakeSearchService()
    setSessionSearchService(service)
    expect(
      await searchSessionService(
        {
          query: 'proof',
          supportedAgents: [],
          supportsQoderHistory: true,
          supportsJcodeHistory: true,
          freshness: 'wait-until-current'
        },
        transport
      )
    ).toMatchObject({ kind: 'results', hits: [], page: { cursor: null, hasMore: false } })
    expect(service.search).toHaveBeenCalledExactlyOnceWith(
      { query: 'proof', limit: 20, freshness: 'wait-until-current' },
      { kind: 'resolved', paths: [''] }
    )
    expect(service.reconcile).toHaveBeenCalledTimes(1)
  }
)

test.each(['relay'] as const)(
  'keeps an unsupported-only filter narrow through normal service checks on %s',
  async (transport) => {
    const request = {
      query: 'proof',
      supportedAgents: ['codex'],
      filters: { agents: ['jcode'] as const },
      freshness: 'wait-until-current' as const
    }
    expect(
      await searchSessionService(
        { ...request, filters: { agents: [...request.filters.agents] } },
        transport
      )
    ).toEqual({ kind: 'unavailable', reason: 'no-service' })
    const service = fakeSearchService()
    setSessionSearchService(service)
    expect(
      await searchSessionService(
        { ...request, filters: { agents: [...request.filters.agents] } },
        transport
      )
    ).toMatchObject({ kind: 'results', hits: [], page: { cursor: null, hasMore: false } })
    expect(service.search).toHaveBeenCalledExactlyOnceWith(
      {
        query: 'proof',
        limit: 20,
        filters: { agents: ['jcode'] },
        freshness: 'wait-until-current'
      },
      { kind: 'resolved', paths: [''] }
    )
    expect(service.status).not.toHaveBeenCalled()
    expect(service.reconcile).toHaveBeenCalledTimes(1)
    for (const reason of ['disabled', 'not-ready'] as const) {
      service.search.mockResolvedValue({ kind: 'unavailable', reason })
      expect(
        await searchSessionService(
          { query: 'proof', supportedAgents: [], filters: { agents: ['jcode'] } },
          transport
        )
      ).toEqual({ kind: 'unavailable', reason })
    }
  }
)

test('keeps current Jcode hits and removes unrequested agents before publication', async () => {
  const service = fakeSearchService()
  service.search.mockResolvedValue({
    ...searchResults(),
    hits: [{ ...searchHit(), agent: 'jcode' }, searchHit()]
  })
  setSessionSearchService(service)
  expect(
    await searchSessionService(
      { query: 'proof', supportedAgents: [...AI_VAULT_AGENTS], filters: { agents: ['jcode'] } },
      'relay'
    )
  ).toMatchObject({ hits: [{ agent: 'jcode' }] })
  expect(service.search).toHaveBeenCalledExactlyOnceWith(
    { query: 'proof', limit: 20, filters: { agents: ['jcode'] } },
    undefined
  )
})
