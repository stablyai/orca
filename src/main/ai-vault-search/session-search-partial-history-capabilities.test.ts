import { afterEach, expect, it } from 'vitest'
import { AI_VAULT_AGENTS } from '../../shared/ai-vault-types'
import { fakeSearchService } from '../../shared/ai-vault-search-test-fixture'
import { searchSessionService, setSessionSearchService } from './session-search-service-registry'

afterEach(() => setSessionSearchService(null))

it.each([
  {},
  { includeDshHistory: false },
  { includeReasonixHistory: false },
  { includeDshHistory: false, includeReasonixHistory: false }
])('keeps an explicit Qoder decoder tag independent of partial opt-ins: %j', async (flags) => {
  const service = fakeSearchService()
  setSessionSearchService(service)
  await searchSessionService(
    { query: 'needle', ...flags, filters: { agents: ['qoder', 'codex'] } },
    'relay'
  )
  expect(service.search).toHaveBeenCalledExactlyOnceWith(
    { query: 'needle', limit: 20, filters: { agents: ['qoder', 'codex'] } },
    undefined
  )
})

it.each(['dsh', 'reasonix'] as const)(
  'applies only the explicit %s opt-out before paging',
  async (agent) => {
    const service = fakeSearchService()
    setSessionSearchService(service)
    const flags =
      agent === 'dsh'
        ? { includeDshHistory: false, includeReasonixHistory: true }
        : { includeDshHistory: true, includeReasonixHistory: false }
    await searchSessionService(
      { query: 'needle', ...flags, filters: { agents: ['dsh', 'reasonix', 'qoder', 'codex'] } },
      'relay'
    )
    expect(service.search).toHaveBeenCalledExactlyOnceWith(
      {
        query: 'needle',
        limit: 20,
        filters: {
          agents: ['dsh', 'reasonix', 'qoder', 'codex'].filter((candidate) => candidate !== agent)
        }
      },
      undefined
    )
  }
)

it('keeps a modern empty inventory authoritative over every legacy opt-in', async () => {
  const service = fakeSearchService()
  setSessionSearchService(service)
  expect(
    await searchSessionService(
      {
        query: 'needle',
        supportedAgents: [],
        includeDshHistory: true,
        includeReasonixHistory: true,
        supportsQoderHistory: true,
        supportsJcodeHistory: true,
        filters: { agents: ['qoder', 'codex'] }
      },
      'relay'
    )
  ).toMatchObject({ kind: 'results', hits: [], page: { cursor: null, hasMore: false } })
  expect(service.search).toHaveBeenCalledExactlyOnceWith(
    { query: 'needle', limit: 20, filters: { agents: ['qoder', 'codex'] } },
    { kind: 'resolved', paths: [''] }
  )
})

it('uses the current inventory ahead of independent old opt-outs', async () => {
  const service = fakeSearchService()
  setSessionSearchService(service)
  await searchSessionService(
    {
      query: 'needle',
      supportedAgents: [...AI_VAULT_AGENTS],
      includeDshHistory: false,
      includeReasonixHistory: false,
      supportsQoderHistory: false,
      filters: { agents: ['reasonix', 'dsh', 'qoder'] }
    },
    'relay'
  )
  expect(service.search).toHaveBeenCalledExactlyOnceWith(
    { query: 'needle', limit: 20, filters: { agents: ['reasonix', 'dsh', 'qoder'] } },
    undefined
  )
})
