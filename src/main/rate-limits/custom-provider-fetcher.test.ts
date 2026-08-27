import { beforeEach, describe, expect, it, vi } from 'vitest'
import { net } from 'electron'
import type { CustomProviderAccount } from '../../shared/custom-provider-types'
import { fetchCustomProviderUsage, resolveJsonPath } from './custom-provider-fetcher'

vi.mock('electron', () => ({
  net: { fetch: vi.fn() }
}))

function makeAccount(overrides: Partial<CustomProviderAccount> = {}): CustomProviderAccount {
  return {
    id: 'acc-1',
    displayName: 'Acme',
    enabled: true,
    usageUrl: 'https://example.com/usage',
    mappingMode: 'percent',
    percentPath: 'percent',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body)
  } as unknown as Response
}

beforeEach(() => {
  vi.mocked(net.fetch).mockReset()
})

describe('resolveJsonPath', () => {
  it('does not resolve inherited/prototype properties (#2)', () => {
    // Why: `segment in current` would previously resolve this truthily even
    // though the parsed JSON response never contains a "constructor" field.
    expect(resolveJsonPath({}, 'constructor').found).toBe(false)
    expect(resolveJsonPath({}, 'toString').found).toBe(false)
    expect(resolveJsonPath({}, 'hasOwnProperty').found).toBe(false)
  })

  it('still resolves genuine own properties, including a literal falsy value', () => {
    expect(resolveJsonPath({ a: { b: 0 } }, 'a.b')).toEqual({ found: true, value: 0 })
  })
})

describe('fetchCustomProviderUsage', () => {
  it('rejects a negative summed used value instead of returning a negative percent (#3)', async () => {
    vi.mocked(net.fetch).mockResolvedValue(jsonResponse({ usage: { used: -5 }, limit: 100 }))
    const account = makeAccount({
      mappingMode: 'used-limit',
      usedPaths: ['usage.used'],
      limitPath: 'limit'
    })

    const result = await fetchCustomProviderUsage(account, 'token')

    expect(result.status).toBe('error')
    expect(result.usedPercent).toBeNull()
    expect(result.failureKind).toBe('out-of-range')
  })

  it('sums multiple usedPaths and rejects only when the total is negative', async () => {
    vi.mocked(net.fetch).mockResolvedValue(jsonResponse({ input: 10, output: -30 }, 200))
    const account = makeAccount({
      mappingMode: 'used-limit',
      usedPaths: ['input', 'output'],
      limitPath: 'limit'
    })

    const result = await fetchCustomProviderUsage(account, 'token')

    expect(result.status).toBe('error')
    expect(result.failureKind).toBe('out-of-range')
  })

  it('computes a valid percent for a healthy used/limit response', async () => {
    vi.mocked(net.fetch).mockResolvedValue(jsonResponse({ used: 25, limit: 100 }))
    const account = makeAccount({
      mappingMode: 'used-limit',
      usedPaths: ['used'],
      limitPath: 'limit'
    })

    const result = await fetchCustomProviderUsage(account, 'token')

    expect(result.status).toBe('ok')
    expect(result.usedPercent).toBe(25)
  })

  it('returns unavailable with no network call when no token is configured', async () => {
    const account = makeAccount()

    const result = await fetchCustomProviderUsage(account, null)

    expect(result.status).toBe('unavailable')
    expect(result.failureKind).toBe('missing-token')
    expect(net.fetch).not.toHaveBeenCalled()
  })
})
