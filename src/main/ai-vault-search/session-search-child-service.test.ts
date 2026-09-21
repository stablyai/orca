import { expect, it, vi } from 'vitest'
import { unavailableSessionSearchStatus } from '../../shared/ai-vault-search-client'
import type { AiVaultSearchStatus } from '../../shared/ai-vault-search-types'
import { createChildSessionSearchService } from './session-search-child-service'

const indexingStatus: AiVaultSearchStatus = {
  ...unavailableSessionSearchStatus(),
  enabled: true,
  phase: 'indexing',
  filesIndexed: 3,
  generation: 7
}

function stubCalls(overrides: Partial<Parameters<typeof createChildSessionSearchService>[0]> = {}) {
  return {
    search: vi.fn(async () => ({ kind: 'unavailable', reason: 'disabled' }) as const),
    status: vi.fn(async () => indexingStatus),
    reconcile: vi.fn(async () => undefined),
    ...overrides
  }
}

it('forwards every call to the child and returns what it answered', async () => {
  const calls = stubCalls()
  const service = createChildSessionSearchService(calls)

  expect(await service.search({ query: 'ledger' })).toEqual({
    kind: 'unavailable',
    reason: 'disabled'
  })
  expect(calls.search).toHaveBeenCalledWith({ query: 'ledger' })
  expect(await service.status()).toEqual(indexingStatus)
  await service.reconcile()
  expect(calls.reconcile).toHaveBeenCalledTimes(1)
})

// A child that is starting, restarting or refusing is "not yet", which is an
// answer to the caller's question; turning it into a throw would make a paired
// client show a transport error for a host that is simply booting.
it('maps a child that cannot answer to not-ready rather than an error', async () => {
  const service = createChildSessionSearchService(
    stubCalls({
      search: vi.fn(() => Promise.reject(new Error('AI Vault service did not become ready.'))),
      status: vi.fn(() => Promise.reject(new Error('AI Vault service queue is full.'))),
      reconcile: vi.fn(() => Promise.reject(new Error('AI Vault service disconnected.')))
    })
  )

  expect(await service.search({ query: 'ledger' })).toEqual({
    kind: 'unavailable',
    reason: 'not-ready'
  })
  expect(await service.status()).toEqual(unavailableSessionSearchStatus())
  await expect(service.reconcile()).resolves.toBeUndefined()
})
