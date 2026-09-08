import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { AI_VAULT_METHODS, AiVaultSearchSessionsParams } from './ai-vault'
import {
  AI_VAULT_SEARCH_LIMIT_MAX,
  AI_VAULT_SEARCH_QUERY_MAX_LENGTH,
  type AiVaultSearchCoverage,
  type AiVaultSearchResult
} from '../../../../shared/ai-vault-search-types'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

const COVERAGE: AiVaultSearchCoverage = {
  enabled: true,
  sessionsIndexed: 3,
  messagesIndexed: 9,
  providers: [],
  backfill: 'complete',
  filesPending: 0,
  lastIndexedAt: null
}

const RESULT: AiVaultSearchResult = {
  hits: [],
  route: 'and',
  durationMs: 4,
  coverage: COVERAGE
}

const INDEX_STATUS = { enabled: true, historyDays: 90, indexSizeBytes: 4096 }

const searchAiVaultSessions = vi.fn()
const readAiVaultSearchCoverage = vi.fn()
const readAiVaultSearchIndexStatus = vi.fn()
const configureAiVaultSessionSearch = vi.fn()
const sshSearchAiVault = vi.fn()

function makeDispatcher(legacy = false): RpcDispatcher {
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    searchAiVaultSessions,
    readAiVaultSearchCoverage,
    readAiVaultSearchIndexStatus,
    configureAiVaultSessionSearch,
    sshSearchAiVault
  } as unknown as OrcaRuntimeService
  return new RpcDispatcher({
    runtime,
    methods: legacy
      ? AI_VAULT_METHODS.filter((method) => !method.name.startsWith('aiVault.sshSearch'))
      : AI_VAULT_METHODS
  })
}

beforeEach(() => {
  searchAiVaultSessions.mockReset()
  searchAiVaultSessions.mockResolvedValue(RESULT)
  readAiVaultSearchCoverage.mockReset()
  readAiVaultSearchCoverage.mockResolvedValue(COVERAGE)
  readAiVaultSearchIndexStatus.mockReset()
  readAiVaultSearchIndexStatus.mockReturnValue(INDEX_STATUS)
  configureAiVaultSessionSearch.mockReset()
  configureAiVaultSessionSearch.mockResolvedValue(INDEX_STATUS)
  sshSearchAiVault.mockReset().mockResolvedValue(RESULT)
})

describe('targeted SSH search wire boundary', () => {
  it('passes final target identity and cancellation without invoking the controlling runtime index', async () => {
    const signal = new AbortController().signal
    expect(
      await makeDispatcher().dispatch(
        makeRequest('aiVault.sshSearchSessions', { targetId: 'C', query: 'needle' }),
        { signal }
      )
    ).toMatchObject({ ok: true, result: RESULT })
    expect(sshSearchAiVault).toHaveBeenCalledWith('C', 'query', { query: 'needle' }, signal)
    expect(searchAiVaultSessions).not.toHaveBeenCalled()
  })
  it('an older registry refuses targeted query and clear instead of stripping the target and executing locally', async () => {
    for (const method of ['aiVault.sshSearchSessions', 'aiVault.sshSearchConfigure']) {
      expect(
        await makeDispatcher(true).dispatch(
          makeRequest(method, { targetId: 'C', query: 'needle', clearIndex: true })
        )
      ).toMatchObject({ ok: false, error: { code: 'method_not_found' } })
    }
    expect(searchAiVaultSessions).not.toHaveBeenCalled()
    expect(configureAiVaultSessionSearch).not.toHaveBeenCalled()
  })
})

describe('AiVaultSearchSessionsParams', () => {
  it('trims the query and requires a non-empty one', () => {
    const parsed = AiVaultSearchSessionsParams.safeParse({ query: '  strict mode  ' })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.query).toBe('strict mode')
    expect(AiVaultSearchSessionsParams.safeParse({ query: '   ' }).success).toBe(false)
    expect(AiVaultSearchSessionsParams.safeParse({}).success).toBe(false)
  })

  it('rejects a query past the length cap', () => {
    const atCap = 'a'.repeat(AI_VAULT_SEARCH_QUERY_MAX_LENGTH)
    expect(AiVaultSearchSessionsParams.safeParse({ query: atCap }).success).toBe(true)
    expect(AiVaultSearchSessionsParams.safeParse({ query: `${atCap}a` }).success).toBe(false)
  })

  it('rejects a limit above the cap and below one', () => {
    expect(
      AiVaultSearchSessionsParams.safeParse({ query: 'q', limit: AI_VAULT_SEARCH_LIMIT_MAX })
        .success
    ).toBe(true)
    expect(
      AiVaultSearchSessionsParams.safeParse({ query: 'q', limit: AI_VAULT_SEARCH_LIMIT_MAX + 1 })
        .success
    ).toBe(false)
    expect(AiVaultSearchSessionsParams.safeParse({ query: 'q', limit: 0 }).success).toBe(false)
    expect(AiVaultSearchSessionsParams.safeParse({ query: 'q', limit: 2.5 }).success).toBe(false)
  })

  it('restricts agents to the known enum', () => {
    expect(
      AiVaultSearchSessionsParams.safeParse({ query: 'q', agents: ['claude', 'codex'] }).success
    ).toBe(true)
    expect(AiVaultSearchSessionsParams.safeParse({ query: 'q', agents: ['nope'] }).success).toBe(
      false
    )
    expect(AiVaultSearchSessionsParams.safeParse({ query: 'q', agents: ['Claude'] }).success).toBe(
      false
    )
  })

  it('requires an ISO datetime for since', () => {
    expect(
      AiVaultSearchSessionsParams.safeParse({ query: 'q', since: '2026-08-01T00:00:00Z' }).success
    ).toBe(true)
    expect(
      AiVaultSearchSessionsParams.safeParse({ query: 'q', since: '2026-08-01T00:00:00+02:00' })
        .success
    ).toBe(true)
    expect(AiVaultSearchSessionsParams.safeParse({ query: 'q', since: '2026-08-01' }).success).toBe(
      false
    )
    expect(AiVaultSearchSessionsParams.safeParse({ query: 'q', since: 'yesterday' }).success).toBe(
      false
    )
  })

  it('constrains sort and tier to their enums', () => {
    expect(AiVaultSearchSessionsParams.safeParse({ query: 'q', sort: 'newest' }).success).toBe(true)
    expect(AiVaultSearchSessionsParams.safeParse({ query: 'q', sort: 'relevance' }).success).toBe(
      true
    )
    expect(AiVaultSearchSessionsParams.safeParse({ query: 'q', sort: 'oldest' }).success).toBe(
      false
    )
    expect(
      AiVaultSearchSessionsParams.safeParse({ query: 'q', tier: 'conversation' }).success
    ).toBe(true)
    expect(AiVaultSearchSessionsParams.safeParse({ query: 'q', tier: 'full' }).success).toBe(true)
    expect(AiVaultSearchSessionsParams.safeParse({ query: 'q', tier: 'partial' }).success).toBe(
      false
    )
  })

  it('accepts only runtime execution host ids', () => {
    expect(
      AiVaultSearchSessionsParams.safeParse({ query: 'q', executionHostId: 'runtime:env-1' })
        .success
    ).toBe(true)
    expect(
      AiVaultSearchSessionsParams.safeParse({ query: 'q', executionHostId: 'ssh:dev-box' }).success
    ).toBe(false)
    expect(
      AiVaultSearchSessionsParams.safeParse({ query: 'q', executionHostId: 'local' }).success
    ).toBe(false)
  })

  it('clamps scopePaths past the cap and rejects an over-long one', () => {
    const scopePaths = Array.from({ length: 70 }, (_, index) => `/p/${index}`)
    const parsed = AiVaultSearchSessionsParams.safeParse({ query: 'q', scopePaths })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.scopePaths).toHaveLength(64)
    expect(
      AiVaultSearchSessionsParams.safeParse({ query: 'q', scopePaths: ['/'.padEnd(5000, 'a')] })
        .success
    ).toBe(false)
  })
})

describe('aiVault.searchSessions handler', () => {
  it('forwards the validated params to the runtime search', async () => {
    const dispatcher = makeDispatcher()

    await expect(
      dispatcher.dispatch(
        makeRequest('aiVault.searchSessions', {
          query: '  resolveTerminalPath ',
          limit: 5,
          agents: ['claude'],
          scopePaths: ['/home/user/repo'],
          since: '2026-08-01T00:00:00Z',
          sort: 'newest',
          tier: 'conversation',
          refresh: false
        })
      )
    ).resolves.toMatchObject({ ok: true, result: RESULT })

    expect(searchAiVaultSessions).toHaveBeenCalledWith(
      {
        query: 'resolveTerminalPath',
        limit: 5,
        agents: ['claude'],
        scopePaths: ['/home/user/repo'],
        since: '2026-08-01T00:00:00Z',
        sort: 'newest',
        tier: 'conversation',
        refresh: false
      },
      undefined
    )
  })

  it('accepts executionHostId but never forwards it to the host-local search', async () => {
    const dispatcher = makeDispatcher()

    await expect(
      dispatcher.dispatch(
        makeRequest('aiVault.searchSessions', { query: 'q', executionHostId: 'runtime:env-1' })
      )
    ).resolves.toMatchObject({ ok: true })

    expect(searchAiVaultSessions).toHaveBeenCalledWith({ query: 'q' }, undefined)
    expect(searchAiVaultSessions.mock.calls[0]?.[0]).not.toHaveProperty('executionHostId')
  })

  it('rejects an invalid request before reaching the runtime', async () => {
    const dispatcher = makeDispatcher()

    await expect(
      dispatcher.dispatch(makeRequest('aiVault.searchSessions', { query: '', limit: 500 }))
    ).resolves.toMatchObject({ ok: false })
    expect(searchAiVaultSessions).not.toHaveBeenCalled()
  })

  it('forwards transport cancellation to the search', async () => {
    const dispatcher = makeDispatcher()
    const controller = new AbortController()

    await dispatcher.dispatch(makeRequest('aiVault.searchSessions', { query: 'q' }), {
      signal: controller.signal
    })

    expect(searchAiVaultSessions).toHaveBeenCalledWith({ query: 'q' }, controller.signal)
  })
})

describe('aiVault.searchCoverage handler', () => {
  it('returns coverage and forwards transport cancellation', async () => {
    const dispatcher = makeDispatcher()
    const controller = new AbortController()

    await expect(
      dispatcher.dispatch(makeRequest('aiVault.searchCoverage', {}), { signal: controller.signal })
    ).resolves.toMatchObject({ ok: true, result: COVERAGE })
    expect(readAiVaultSearchCoverage).toHaveBeenCalledWith(controller.signal)
  })
})

describe('host-local execution boundary', () => {
  // Every one of these runs on this host's own index. An id naming a host this
  // process does not execute on must be refused, not answered locally.
  const methods = [
    ['aiVault.searchSessions', { query: 'q' }],
    ['aiVault.searchCoverage', {}],
    ['aiVault.searchIndexStatus', {}],
    ['aiVault.configureSessionSearch', { enabled: true }]
  ] as const

  it.each(['ssh:build-server', 'local', 'not-a-host'])(
    'refuses %s on every search method instead of answering with this host',
    async (executionHostId) => {
      const dispatcher = makeDispatcher()
      for (const [method, params] of methods) {
        await expect(
          dispatcher.dispatch(makeRequest(method, { ...params, executionHostId }))
        ).resolves.toMatchObject({ ok: false })
      }
      expect(searchAiVaultSessions).not.toHaveBeenCalled()
      expect(readAiVaultSearchCoverage).not.toHaveBeenCalled()
      expect(readAiVaultSearchIndexStatus).not.toHaveBeenCalled()
      expect(configureAiVaultSessionSearch).not.toHaveBeenCalled()
    }
  )

  it('accepts a runtime id on every search method without letting it route the call', async () => {
    const dispatcher = makeDispatcher()
    for (const [method, params] of methods) {
      await expect(
        dispatcher.dispatch(makeRequest(method, { ...params, executionHostId: 'runtime:env-1' }))
      ).resolves.toMatchObject({ ok: true })
    }
    expect(searchAiVaultSessions.mock.calls[0]?.[0]).not.toHaveProperty('executionHostId')
    expect(configureAiVaultSessionSearch.mock.calls[0]?.[0]).not.toHaveProperty('executionHostId')
    expect(sshSearchAiVault).not.toHaveBeenCalled()
  })
})

describe('aiVault.configureSessionSearch handler', () => {
  it('forwards the consent change without the host id it was addressed by', async () => {
    const dispatcher = makeDispatcher()

    await expect(
      dispatcher.dispatch(
        makeRequest('aiVault.configureSessionSearch', {
          enabled: true,
          historyDays: 90,
          executionHostId: 'runtime:env-1'
        })
      )
    ).resolves.toMatchObject({ ok: true, result: INDEX_STATUS })

    expect(configureAiVaultSessionSearch).toHaveBeenCalledWith({ enabled: true, historyDays: 90 })
  })

  it('accepts a null historyDays as "all history"', async () => {
    const dispatcher = makeDispatcher()

    await dispatcher.dispatch(makeRequest('aiVault.configureSessionSearch', { historyDays: null }))

    expect(configureAiVaultSessionSearch).toHaveBeenCalledWith({ historyDays: null })
  })

  it('rejects a negative or over-long history bound before reaching the runtime', async () => {
    const dispatcher = makeDispatcher()

    await expect(
      dispatcher.dispatch(makeRequest('aiVault.configureSessionSearch', { historyDays: -1 }))
    ).resolves.toMatchObject({ ok: false })
    await expect(
      dispatcher.dispatch(makeRequest('aiVault.configureSessionSearch', { historyDays: 100000 }))
    ).resolves.toMatchObject({ ok: false })
    expect(configureAiVaultSessionSearch).not.toHaveBeenCalled()
  })
})

describe('aiVault.searchIndexStatus handler', () => {
  it('reports the policy and the index footprint', async () => {
    const dispatcher = makeDispatcher()

    await expect(
      dispatcher.dispatch(makeRequest('aiVault.searchIndexStatus', {}))
    ).resolves.toMatchObject({ ok: true, result: INDEX_STATUS })
  })
})
