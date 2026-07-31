import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CURSOR_ACCESS_TOKEN_KEY, CURSOR_CACHED_EMAIL_KEY } from '../../shared/cursor-session-paths'

const netFetchMock = vi.hoisted(() => vi.fn())
const dbState = vi.hoisted<{ token: string | null; email: string | null }>(() => ({
  token: null,
  email: null
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

vi.mock('node:fs', () => ({
  existsSync: () => dbState.token !== null
}))

vi.mock('../sqlite/sync-database', () => ({
  default: class MockDatabase {
    prepare(sql: string) {
      return {
        get: (key: string) => {
          if (!sql.includes('ItemTable')) {
            return undefined
          }
          if (key === CURSOR_ACCESS_TOKEN_KEY && dbState.token) {
            return { value: dbState.token }
          }
          if (key === CURSOR_CACHED_EMAIL_KEY && dbState.email) {
            return { value: dbState.email }
          }
          return undefined
        }
      }
    }
    close() {}
  }
}))

vi.mock('node:os', () => ({ homedir: () => '/home/test' }))

import { fetchCursorRateLimits } from './cursor-fetcher'

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

function textResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body
  } as Response
}

const USAGE_SUMMARY = {
  billingCycleStart: '2026-07-01T00:00:00.000Z',
  billingCycleEnd: '2026-08-01T00:00:00.000Z',
  membershipType: 'pro',
  individualUsage: {
    plan: {
      used: 1200,
      limit: 2000,
      autoPercentUsed: 45,
      apiPercentUsed: 30,
      totalPercentUsed: 60
    },
    onDemand: { enabled: true, used: 100, limit: 5000 }
  }
}

describe('fetchCursorRateLimits', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
    dbState.token = null
    dbState.email = null
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns unavailable when not signed in', async () => {
    const result = await fetchCursorRateLimits()
    expect(result.provider).toBe('cursor')
    expect(result.status).toBe('unavailable')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('maps plan total into monthly only', async () => {
    const token = makeJwt({ sub: 'auth0|cursor-user', exp: 4_102_444_800 })
    dbState.token = token
    dbState.email = 'cached@example.com'
    netFetchMock
      .mockResolvedValueOnce(textResponse(JSON.stringify(USAGE_SUMMARY)))
      .mockResolvedValueOnce(textResponse(JSON.stringify({ email: 'dev@example.com' })))

    const result = await fetchCursorRateLimits()
    expect(result.status).toBe('ok')
    expect(result.provider).toBe('cursor')
    expect(result.monthly?.usedPercent).toBe(60)
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(result.buckets).toEqual([
      expect.objectContaining({ name: 'Auto', usedPercent: 45 }),
      expect.objectContaining({ name: 'API', usedPercent: 30 })
    ])
    expect(result.usageMetadata?.source).toBe('web')
    expect(result.usageMetadata?.authProvenance).toContain('cached@example.com')
    expect(result.usageMetadata?.authProvenance).toContain('pro')

    expect(netFetchMock).toHaveBeenNthCalledWith(
      1,
      'https://cursor.com/api/usage-summary',
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: `WorkosCursorSessionToken=cursor-user%3A%3A${token}`
        })
      })
    )
  })

  it('returns unavailable for expired access tokens without fetching', async () => {
    dbState.token = makeJwt({ sub: 'auth0|cursor-user', exp: 1_000_000_000 })
    const result = await fetchCursorRateLimits()
    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('stale-token')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('returns unavailable when usage-summary responds unauthorized', async () => {
    const token = makeJwt({ sub: 'auth0|cursor-user', exp: 4_102_444_800 })
    dbState.token = token
    netFetchMock.mockResolvedValueOnce(textResponse('unauthorized', 401))

    const result = await fetchCursorRateLimits()
    expect(result.status).toBe('unavailable')
    expect(result.error).toMatch(/sign in/i)
  })
})
