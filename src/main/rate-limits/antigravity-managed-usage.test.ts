import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeResponse } from './gemini-usage-fetcher.test-fixtures'
import type * as AntigravityOauthSourcesModule from './antigravity-oauth-sources'
import type * as ManagedOauthModule from '../antigravity-accounts/managed-oauth'
import type { AntigravityManagedAccount } from '../../shared/managed-account-types'
import type { AntigravityTokenStore } from '../antigravity-accounts/token-store'

const { readFileMock, extractCredsMock, netFetchMock, keychainMock, refreshMock } = vi.hoisted(
  () => ({
    readFileMock: vi.fn(),
    extractCredsMock: vi.fn(),
    netFetchMock: vi.fn(),
    keychainMock: vi.fn(),
    refreshMock: vi.fn()
  })
)

vi.mock('./gemini-cli-oauth-extractor', () => ({
  extractOAuthClientCredentials: extractCredsMock
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))

vi.mock('./antigravity-oauth-sources', async (importOriginal) => {
  const actual = await importOriginal<typeof AntigravityOauthSourcesModule>()
  return {
    ...actual,
    readAntigravityKeychainCredentials: keychainMock
  }
})

vi.mock('../antigravity-accounts/managed-oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof ManagedOauthModule>()
  return {
    ...actual,
    refreshAntigravityAccountToken: refreshMock
  }
})

import {
  fetchAntigravityManagedAccountUsage,
  setAntigravityTokenStoreForTests
} from './antigravity-managed-account-fetch'

function makeAccount(
  overrides: Partial<AntigravityManagedAccount> = {}
): AntigravityManagedAccount {
  return {
    id: 'acct-1',
    email: 'test@example.com',
    projectId: 'proj-1',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...overrides
  }
}

function makeTokenStore(
  tokens: { refreshToken: string; accessToken: string | null; expiryDate: number | null } | null
) {
  let stored = tokens
  const store: AntigravityTokenStore = {
    read: vi.fn(async () => stored),
    write: vi.fn(async (_id, next) => {
      stored = next
    }),
    remove: vi.fn(async () => {
      stored = null
    })
  }
  return store
}

const modelsResponse = {
  models: {
    'claude-sonnet-4-6': {
      displayName: 'Claude Sonnet 4.6',
      quotaInfo: { remainingFraction: 0.5, resetTime: '2026-04-24T13:00:00.000Z' }
    }
  }
}

describe('fetchAntigravityManagedAccountUsage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'))
    netFetchMock.mockReset()
    refreshMock.mockReset()
    netFetchMock.mockImplementation((url: string) => {
      if (url.includes('fetchAvailableModels')) {
        return Promise.resolve(makeResponse(modelsResponse))
      }
      return Promise.resolve(makeResponse({}, 404))
    })
  })

  it('fetches quota with the stored access token when fresh', async () => {
    const store = makeTokenStore({
      refreshToken: 'rt',
      accessToken: 'fresh-token',
      expiryDate: Date.now() + 3600_000
    })
    const result = await fetchAntigravityManagedAccountUsage(makeAccount(), store)
    expect(result.status).toBe('ok')
    expect(result.buckets).toHaveLength(1)
    expect(netFetchMock.mock.calls[0]?.[1]?.headers?.Authorization).toBe('Bearer fresh-token')
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it('refreshes expired tokens and persists them back to the vault', async () => {
    const store = makeTokenStore({
      refreshToken: 'rt',
      accessToken: null,
      expiryDate: Date.now() - 1000
    })
    refreshMock.mockResolvedValue({
      accessToken: 'rotated-token',
      expiryDate: Date.now() + 3600_000
    })
    const result = await fetchAntigravityManagedAccountUsage(makeAccount(), store)
    expect(result.status).toBe('ok')
    expect(refreshMock).toHaveBeenCalledWith('rt')
    expect(store.write).toHaveBeenCalledWith('acct-1', {
      refreshToken: 'rt',
      accessToken: 'rotated-token',
      expiryDate: Date.now() + 3600_000
    })
    expect(netFetchMock.mock.calls[0]?.[1]?.headers?.Authorization).toBe('Bearer rotated-token')
  })

  it('reports an error when refresh fails', async () => {
    const store = makeTokenStore({
      refreshToken: 'rt',
      accessToken: 'stale',
      expiryDate: Date.now() - 1000
    })
    refreshMock.mockRejectedValue(new Error('Token refresh failed (HTTP 400)'))
    const result = await fetchAntigravityManagedAccountUsage(makeAccount(), store)
    expect(result.status).toBe('error')
    expect(result.error).toContain('test@example.com')
  })

  it('reports an error when the vault has no credentials', async () => {
    const store = makeTokenStore(null)
    const result = await fetchAntigravityManagedAccountUsage(makeAccount(), store)
    expect(result.status).toBe('error')
    expect(result.error).toContain('remove and re-add')
  })
})

describe('token store singleton override', () => {
  it('setAntigravityTokenStoreForTests accepts null without touching electron', () => {
    setAntigravityTokenStoreForTests(null)
    setAntigravityTokenStoreForTests(makeTokenStore(null))
  })
})
