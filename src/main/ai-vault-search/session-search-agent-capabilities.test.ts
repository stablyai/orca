import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSessionSearchClient,
  unavailableSessionSearchStatus
} from '../../shared/ai-vault-search-client'
import { AiVaultSearchRequestSchema as LegacyRequestSchema } from '../../shared/__fixtures__/pre-qoder-search-request'
import { AI_VAULT_AGENTS } from '../../shared/ai-vault-types'
import type { AiVaultSearchRequest } from '../../shared/ai-vault-search-types'
import { fakeSearchService, searchResults } from '../../shared/ai-vault-search-test-fixture'
import {
  searchSessionService,
  sessionSearchServiceStatus,
  setSessionSearchService
} from './session-search-service-registry'

afterEach(() => setSessionSearchService(null))

const CAPABILITIES = [
  { dshHistory: false, supportsQoderHistory: false, agents: ['codex'] },
  { dshHistory: true, supportsQoderHistory: false, agents: ['dsh', 'codex'] },
  { dshHistory: false, supportsQoderHistory: true, agents: ['qoder', 'codex'] },
  { dshHistory: true, supportsQoderHistory: true, agents: ['dsh', 'qoder', 'codex'] }
] as const

describe('combined DSH and Qoder host capabilities', () => {
  for (const transport of ['runtime', 'relay'] as const) {
    it.each(CAPABILITIES)(
      `negotiates both agent filters independently over ${transport}: %j`,
      async ({ dshHistory, supportsQoderHistory, agents }) => {
        const call = vi.fn(async (method: string, params: unknown) => {
          if (method === 'aiVault.searchStatus') {
            return { ...unavailableSessionSearchStatus(), dshHistory, supportsQoderHistory }
          }
          if (!dshHistory && !supportsQoderHistory) {
            LegacyRequestSchema.parse(params)
          }
          return searchResults()
        })
        const request: AiVaultSearchRequest = {
          query: 'needle',
          scope: 'conversation' as const,
          limit: 42,
          cursor: 'page-1',
          debug: true,
          freshness: 'wait-until-current' as const,
          filters: {
            agents: ['dsh', 'qoder', 'codex'],
            scopePaths: ['/host/folder'],
            since: '2026-08-01T00:00:00Z',
            sort: 'newest' as const
          }
        }
        await createSessionSearchClient(call, transport).searchSessions(request)
        expect(call).toHaveBeenCalledTimes(2)
        expect(call).toHaveBeenNthCalledWith(1, 'aiVault.searchStatus', {})
        expect(call).toHaveBeenNthCalledWith(2, 'aiVault.searchSessions', {
          ...request,
          filters: { ...request.filters, agents: [...agents] },
          includeDshHistory: true,
          supportedAgents: [...AI_VAULT_AGENTS],
          supportsQoderHistory: true,
          supportsJcodeHistory: true
        })
      }
    )
    it(`does not widen a selection containing only unsupported new agents over ${transport}`, async () => {
      const call = vi.fn(async () => unavailableSessionSearchStatus())
      expect(
        await createSessionSearchClient(call, transport).searchSessions({
          query: 'needle',
          filters: { agents: ['dsh', 'qoder'] }
        })
      ).toEqual({ kind: 'unavailable', reason: 'unsupported-agent' })
      expect(call).toHaveBeenCalledExactlyOnceWith('aiVault.searchStatus', {})
    })
  }

  it.each(CAPABILITIES)(
    'honors the independent relay opt-ins before invoking the host index: %j',
    async ({ dshHistory, supportsQoderHistory, agents }) => {
      const service = fakeSearchService()
      setSessionSearchService(service)
      await searchSessionService(
        {
          query: 'needle',
          includeDshHistory: dshHistory,
          supportsQoderHistory,
          filters: { agents: ['dsh', 'qoder', 'codex'], scopePaths: ['/host/folder'] }
        },
        'relay'
      )
      expect(service.search).toHaveBeenCalledExactlyOnceWith(
        {
          query: 'needle',
          limit: 20,
          filters: { agents: [...agents], scopePaths: ['/host/folder'] }
        },
        undefined
      )
    }
  )

  it.each(['ipc', 'runtime', 'relay'] as const)(
    'keeps both defaults and capability advertisements on %s',
    async (transport) => {
      const service = fakeSearchService()
      setSessionSearchService(service)
      await searchSessionService({ query: 'needle' }, transport)
      expect(service.search).toHaveBeenCalledExactlyOnceWith(
        {
          query: 'needle',
          limit: 20,
          ...(transport === 'ipc'
            ? {}
            : {
                filters: {
                  agents: AI_VAULT_AGENTS.filter(
                    (agent) => !['codebuddy', 'zcode', 'qoder', 'jcode', 'dsh'].includes(agent)
                  )
                }
              })
        },
        undefined
      )
      expect(await sessionSearchServiceStatus({}, transport)).toMatchObject({
        dshHistory: true,
        supportedAgents: [...AI_VAULT_AGENTS],
        supportsQoderHistory: true,
        supportsJcodeHistory: true
      })
    }
  )
})
