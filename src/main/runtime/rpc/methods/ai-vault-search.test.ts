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

const searchAiVaultSessions = vi.fn()
const readAiVaultSearchCoverage = vi.fn()

function makeDispatcher(): RpcDispatcher {
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    searchAiVaultSessions,
    readAiVaultSearchCoverage
  } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })
}

beforeEach(() => {
  searchAiVaultSessions.mockReset()
  searchAiVaultSessions.mockResolvedValue(RESULT)
  readAiVaultSearchCoverage.mockReset()
  readAiVaultSearchCoverage.mockResolvedValue(COVERAGE)
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

  it('rejects a non-runtime execution host id', async () => {
    const dispatcher = makeDispatcher()

    await expect(
      dispatcher.dispatch(makeRequest('aiVault.searchCoverage', { executionHostId: 'ssh:box' }))
    ).resolves.toMatchObject({ ok: false })
    expect(readAiVaultSearchCoverage).not.toHaveBeenCalled()
  })
})
