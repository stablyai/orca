import { afterEach, expect, test } from 'vitest'
import { AI_VAULT_AGENTS } from '../../shared/ai-vault-types'
import {
  fakeSearchService,
  searchHit,
  searchResults
} from '../../shared/ai-vault-search-test-fixture'
import {
  searchSessionService,
  setSessionSearchService,
  sessionSearchServiceStatus
} from './session-search-service-registry'
import {
  encodeSessionSearchCursor,
  decodeSessionSearchCursor,
  sessionSearchPageKey,
  SessionSearchCursorError
} from './session-search-page-cursor'

afterEach(() => setSessionSearchService(null))

test('keeps omitted Qoder decoder support when an unrelated DSH flag is false', async () => {
  const service = fakeSearchService()
  setSessionSearchService(service)
  const request = { query: 'proof', filters: { agents: ['qoder', 'codex'] } }
  await searchSessionService(request, 'relay')
  expect(service.search).toHaveBeenLastCalledWith({ ...request, limit: 20 }, undefined)
  await searchSessionService({ ...request, includeDshHistory: false }, 'relay')
  expect(service.search).toHaveBeenLastCalledWith({ ...request, limit: 20 }, undefined)
})

test.each(['runtime', 'relay'] as const)(
  'constrains only the explicitly supplied legacy provider on %s',
  async (transport) => {
    const cases = [
      {
        flags: { includeDshHistory: false },
        expected: ['codebuddy', 'zcode', 'qoder', 'jcode', 'codex']
      },
      {
        flags: { includeDshHistory: true },
        expected: ['codebuddy', 'zcode', 'qoder', 'jcode', 'codex', 'dsh']
      },
      { flags: { supportsQoderHistory: false }, expected: ['jcode', 'codex'] },
      {
        flags: { supportsQoderHistory: true },
        expected: ['codebuddy', 'zcode', 'qoder', 'jcode', 'codex']
      },
      {
        flags: { supportsJcodeHistory: false },
        expected: ['codebuddy', 'zcode', 'qoder', 'codex']
      },
      {
        flags: { supportsJcodeHistory: true },
        expected: ['codebuddy', 'zcode', 'qoder', 'jcode', 'codex']
      },
      {
        flags: { includeDshHistory: true, supportsQoderHistory: false },
        expected: ['jcode', 'codex', 'dsh']
      },
      {
        flags: { includeDshHistory: true, supportsJcodeHistory: false },
        expected: ['codebuddy', 'zcode', 'qoder', 'codex', 'dsh']
      }
    ]
    for (const { flags, expected } of cases) {
      const service = fakeSearchService()
      setSessionSearchService(service)
      await searchSessionService(
        {
          query: 'proof',
          filters: { agents: ['codebuddy', 'zcode', 'qoder', 'jcode', 'codex', 'dsh'] },
          ...flags
        },
        transport
      )
      expect(service.search, JSON.stringify(flags)).toHaveBeenCalledExactlyOnceWith(
        { query: 'proof', limit: 20, filters: { agents: expected } },
        undefined
      )
    }
  }
)

test.each(['runtime', 'relay'] as const)(
  'keeps explicit own-provider opt-outs authoritative for sole filters on %s',
  async (transport) => {
    for (const agent of ['codebuddy', 'zcode', 'qoder', 'jcode'] as const) {
      const service = fakeSearchService()
      setSessionSearchService(service)
      const field = agent === 'jcode' ? 'supportsJcodeHistory' : 'supportsQoderHistory'
      expect(
        await searchSessionService(
          { query: 'proof', filters: { agents: [agent] }, [field]: false },
          transport
        )
      ).toMatchObject({ kind: 'results', hits: [], page: { cursor: null, hasMore: false } })
      expect(service.search).toHaveBeenCalledExactlyOnceWith(
        { query: 'proof', limit: 20, filters: { agents: [agent] } },
        { kind: 'resolved', paths: [''] }
      )
      service.search.mockClear()
      await searchSessionService(
        { query: 'proof', filters: { agents: [agent] }, includeDshHistory: false },
        transport
      )
      expect(service.search).toHaveBeenCalledExactlyOnceWith(
        { query: 'proof', limit: 20, filters: { agents: [agent] } },
        undefined
      )
    }
  }
)

test.each([
  { supportedAgents: [] },
  { supportedAgents: ['codex'] },
  { supportedAgents: ['qoder', 'jcode'] }
] as const)(
  'uses an explicit modern catalog %j before flags or requested decoder tags',
  async ({ supportedAgents }) => {
    const service = fakeSearchService()
    setSessionSearchService(service)
    const result = await searchSessionService(
      {
        query: 'proof',
        filters: { agents: ['qoder', 'jcode', 'codex', 'dsh'] },
        supportedAgents: [...supportedAgents],
        includeDshHistory: true,
        supportsQoderHistory: false,
        supportsJcodeHistory: false
      },
      'relay'
    )
    if (supportedAgents.length === 0) {
      expect(result).toMatchObject({
        kind: 'results',
        hits: [],
        page: { cursor: null, hasMore: false }
      })
      expect(service.search).toHaveBeenCalledExactlyOnceWith(
        { query: 'proof', limit: 20, filters: { agents: ['qoder', 'jcode', 'codex', 'dsh'] } },
        { kind: 'resolved', paths: [''] }
      )
    } else {
      expect(service.search).toHaveBeenCalledExactlyOnceWith(
        { query: 'proof', limit: 20, filters: { agents: [...supportedAgents] } },
        undefined
      )
    }
  }
)

test.each(['runtime', 'relay'] as const)(
  'publishes the current supported catalog independently of indexed data on %s',
  async (transport) => {
    expect(await sessionSearchServiceStatus({}, transport)).toMatchObject({
      enabled: false,
      supportedAgents: [...AI_VAULT_AGENTS],
      supportsQoderHistory: true,
      supportsJcodeHistory: true
    })
    const service = fakeSearchService()
    setSessionSearchService(service)
    expect((await sessionSearchServiceStatus({}, transport)).supportedAgents).toEqual(
      AI_VAULT_AGENTS
    )
    expect(service.status.mock.lastCall).toEqual([])
  }
)

test.each(['runtime', 'relay'] as const)(
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

test.each(['qoder', 'jcode'] as const)(
  'projects the independent %s history capability before retrieval',
  async (agent) => {
    const service = fakeSearchService()
    setSessionSearchService(service)
    const supportField = agent === 'qoder' ? 'supportsQoderHistory' : 'supportsJcodeHistory'
    await searchSessionService({ query: 'proof', [supportField]: true }, 'relay')
    expect(service.search).toHaveBeenCalledExactlyOnceWith(
      {
        query: 'proof',
        limit: 20,
        filters: {
          agents: AI_VAULT_AGENTS.filter(
            (candidate) =>
              candidate !== 'dsh' &&
              (agent === 'qoder'
                ? candidate !== 'jcode'
                : !['codebuddy', 'zcode', 'qoder'].includes(candidate))
          )
        }
      },
      undefined
    )
  }
)

test.each(['runtime', 'relay'] as const)(
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

test('projects agents before cursor identity and preserves every other ranking field', async () => {
  const service = fakeSearchService()
  service.search.mockImplementation(async (request) => {
    const key = sessionSearchPageKey(request)
    if (request.cursor) {
      try {
        decodeSessionSearchCursor(request.cursor, 7, key, 'test-index')
      } catch (error) {
        if (error instanceof SessionSearchCursorError) {
          return { kind: 'malformed-cursor' }
        }
        throw error
      }
    }
    return {
      ...searchResults(),
      page: { cursor: encodeSessionSearchCursor(7, 1, key, 'test-index'), hasMore: true }
    }
  })
  setSessionSearchService(service)
  const request = {
    query: 'proof',
    supportedAgents: ['codex'],
    scope: 'conversation' as const,
    limit: 42,
    debug: true,
    filters: {
      agents: ['codex', 'jcode'] as const,
      scopePaths: ['/host/folder'],
      since: '2026-08-01T00:00:00Z',
      sort: 'newest' as const
    }
  }
  const first = await searchSessionService(
    { ...request, filters: { ...request.filters, agents: [...request.filters.agents] } },
    'relay'
  )
  if (first.kind !== 'results' || !first.page.cursor) {
    throw new Error('Expected a first page with a cursor')
  }
  const next = {
    ...request,
    filters: { ...request.filters, agents: [...request.filters.agents] },
    cursor: first.page.cursor
  }
  expect(await searchSessionService(next, 'relay')).toMatchObject({ kind: 'results' })
  const { supportedAgents: _supportedAgents, ...expected } = next
  expect(service.search).toHaveBeenLastCalledWith(
    { ...expected, filters: { ...next.filters, agents: ['codex'] } },
    undefined
  )
  expect(
    await searchSessionService({ ...next, supportedAgents: [...AI_VAULT_AGENTS] }, 'relay')
  ).toEqual({ kind: 'malformed-cursor' })
})

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
