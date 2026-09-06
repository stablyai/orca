import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleBalance } from '../../types/console-api'

const { netFetchMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn()
}))

vi.mock('electron', () => ({
  net: {
    fetch: netFetchMock
  }
}))

import { ConsoleBalanceFetcher } from './console-balance-fetcher'

describe('ConsoleBalance types', () => {
  it('can represent a valid console balance', () => {
    const balance: ConsoleBalance = {
      organization_id: 'org-123',
      balance_in_cents: 100_000,
      spend_rate_cents_per_hour: 1500,
      last_fetched_at: Date.now()
    }
    expect(balance.organization_id).toBe('org-123')
    expect(balance.balance_in_cents).toBe(100_000)
    expect(balance.spend_rate_cents_per_hour).toBe(1500)
    expect(typeof balance.last_fetched_at).toBe('number')
  })

  it('allows optional spend_rate_cents_per_hour', () => {
    const balance: ConsoleBalance = {
      organization_id: 'org-456',
      balance_in_cents: 50_000,
      last_fetched_at: Date.now()
    }
    expect(balance.spend_rate_cents_per_hour).toBeUndefined()
  })
})

describe('ConsoleBalanceFetcher', () => {
  let fetcher: ConsoleBalanceFetcher

  beforeEach(() => {
    vi.clearAllMocks()
    fetcher = new ConsoleBalanceFetcher()
  })

  it('builds URL correctly with default endpoint', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'org-123',
          balance_in_cents: 100_000
        }),
        { status: 200 }
      )
    )

    await fetcher.fetch('test-key')

    expect(netFetchMock).toHaveBeenCalledOnce()
    const [url] = netFetchMock.mock.calls[0]
    expect(url).toBe('https://console.claude.ai/api/organizations/balance')
  })

  it('builds URL correctly with custom endpoint', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'org-123',
          balance_in_cents: 100_000
        }),
        { status: 200 }
      )
    )

    await fetcher.fetch('test-key', 'https://custom.example.com/api/')

    const [url] = netFetchMock.mock.calls[0]
    expect(url).toBe('https://custom.example.com/api/organizations/balance')
  })

  it('builds URL correctly when custom endpoint lacks trailing slash', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'org-123',
          balance_in_cents: 100_000
        }),
        { status: 200 }
      )
    )

    await fetcher.fetch('test-key', 'https://custom.example.com/api')

    const [url] = netFetchMock.mock.calls[0]
    expect(url).toMatch(/^https:\/\/custom\.example\.com\/api\/organizations\/balance$/)
  })

  it('wraps a malformed endpoint instead of leaking a raw TypeError', async () => {
    await expect(fetcher.fetch('test-key', 'not-a-url')).rejects.toThrow(
      /Failed to fetch console balance:/
    )
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('rejects a non-object JSON body', async () => {
    for (const body of ['null', '[]', '"text"']) {
      netFetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }))
      await expect(fetcher.fetch('test-key')).rejects.toThrow(/must be an object/)
    }
  })

  it('rejects a non-finite balance', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response('{"id":"org-123","balance_in_cents":1e999}', { status: 200 })
    )
    await expect(fetcher.fetch('test-key')).rejects.toThrow(/balance_in_cents/)
  })

  it('drops a non-finite spend rate rather than propagating it', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response(
        '{"id":"org-123","balance_in_cents":100,"spending_metrics":{"spend_rate_cents_per_hour":1e999}}',
        { status: 200 }
      )
    )
    const balance = await fetcher.fetch('test-key')
    expect(balance.spend_rate_cents_per_hour).toBeUndefined()
  })

  it('normalizes a non-Error rejection', async () => {
    netFetchMock.mockRejectedValueOnce('socket closed')
    await expect(fetcher.fetch('test-key')).rejects.toThrow(
      'Failed to fetch console balance: socket closed'
    )
  })

  it('aborts the request when the caller signal aborts', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'org-123', balance_in_cents: 100_000 }), { status: 200 })
    )
    const controller = new AbortController()

    await fetcher.fetch('test-key', undefined, controller.signal)

    const [, init] = netFetchMock.mock.calls[0]
    expect(init.signal.aborted).toBe(false)
    controller.abort()
    expect(init.signal.aborted).toBe(true)
  })

  it('sends Authorization header with Bearer token', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'org-123',
          balance_in_cents: 100_000
        }),
        { status: 200 }
      )
    )

    await fetcher.fetch('my-secret-key')

    const [, options] = netFetchMock.mock.calls[0]
    expect(options?.headers).toEqual({
      Authorization: 'Bearer my-secret-key',
      'Content-Type': 'application/json'
    })
  })

  it('includes 10-second timeout signal', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'org-123',
          balance_in_cents: 100_000
        }),
        { status: 200 }
      )
    )

    await fetcher.fetch('test-key')

    const [, options] = netFetchMock.mock.calls[0]
    expect(options?.signal).toBeDefined()
    // Verify it's an AbortSignal (can't check timeout value directly, but presence indicates correct pattern)
    expect(options?.signal).toBeInstanceOf(AbortSignal)
  })

  it('maps response fields correctly', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'org-abc-123',
          balance_in_cents: 75_000,
          spending_metrics: {
            spend_rate_cents_per_hour: 2500
          }
        }),
        { status: 200 }
      )
    )

    const result = await fetcher.fetch('test-key')

    expect(result.organization_id).toBe('org-abc-123')
    expect(result.balance_in_cents).toBe(75_000)
    expect(result.spend_rate_cents_per_hour).toBe(2500)
    expect(typeof result.last_fetched_at).toBe('number')
  })

  it('ignores missing spending_metrics', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'org-xyz',
          balance_in_cents: 50_000
        }),
        { status: 200 }
      )
    )

    const result = await fetcher.fetch('test-key')

    expect(result.organization_id).toBe('org-xyz')
    expect(result.balance_in_cents).toBe(50_000)
    expect(result.spend_rate_cents_per_hour).toBeUndefined()
  })

  it('ignores non-numeric spend_rate in spending_metrics', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'org-123',
          balance_in_cents: 100_000,
          spending_metrics: {
            spend_rate_cents_per_hour: 'invalid'
          }
        }),
        { status: 200 }
      )
    )

    const result = await fetcher.fetch('test-key')

    expect(result.spend_rate_cents_per_hour).toBeUndefined()
  })

  it('throws on non-ok response status', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        statusText: 'Unauthorized'
      })
    )

    await expect(fetcher.fetch('invalid-key')).rejects.toThrow(/Console API 401: Unauthorized/)
  })

  it('throws on missing id field', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          balance_in_cents: 100_000
        }),
        { status: 200 }
      )
    )

    await expect(fetcher.fetch('test-key')).rejects.toThrow(
      /Console API response missing or invalid id field/
    )
  })

  it('throws on non-string id field', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 12345,
          balance_in_cents: 100_000
        }),
        { status: 200 }
      )
    )

    await expect(fetcher.fetch('test-key')).rejects.toThrow(
      /Console API response missing or invalid id field/
    )
  })

  it('throws on missing balance_in_cents field', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'org-123'
        }),
        { status: 200 }
      )
    )

    await expect(fetcher.fetch('test-key')).rejects.toThrow(
      /Console API response missing or invalid balance_in_cents field/
    )
  })

  it('throws on non-numeric balance_in_cents field', async () => {
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'org-123',
          balance_in_cents: '100000'
        }),
        { status: 200 }
      )
    )

    await expect(fetcher.fetch('test-key')).rejects.toThrow(
      /Console API response missing or invalid balance_in_cents field/
    )
  })

  it('wraps fetch errors with context', async () => {
    netFetchMock.mockRejectedValueOnce(new Error('Network timeout'))

    await expect(fetcher.fetch('test-key')).rejects.toThrow(
      /Failed to fetch console balance: Network timeout/
    )
  })
})
