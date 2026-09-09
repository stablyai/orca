import { beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())
const authState = vi.hoisted(() => ({ file: null as string | null }))

vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))
vi.mock('node:fs', () => ({
  existsSync: () => authState.file !== null,
  readFileSync: () => authState.file
}))
vi.mock('node:os', () => ({ homedir: () => '/home/test' }))

import { fetchGrokRateLimits } from './grok-fetcher'
import {
  encodeGetRemainingResetsResponse,
  encodeGrpcWebMessage,
  GROK_REMAINING_RESETS_URL
} from './grok-reset-credit-client'

const BILLING_RESPONSE = {
  config: {
    creditUsagePercent: 42,
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-06-30T18:36:14.268512+00:00',
      end: '2026-07-07T18:36:14.268512+00:00'
    },
    subscriptionTier: 'SuperGrok',
    isUnifiedBillingUser: true
  }
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

function grpcWebResponse(payload: Uint8Array<ArrayBufferLike>, grpcStatus = '0'): Response {
  const body = encodeGrpcWebMessage(payload, grpcStatus)
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/grpc-web+proto' }),
    arrayBuffer: async () => body.slice().buffer
  } as Response
}

describe('fetchGrokRateLimits reset-token inventory', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
    authState.file = JSON.stringify({
      'https://auth.x.ai::client': {
        key: 'access-token',
        user_id: 'user-1',
        email: 'dev@example.com',
        expires_at: '2099-01-01T00:00:00.000Z'
      }
    })
  })

  it('attaches SuperGrok remaining reset tokens next to weekly usage', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse(BILLING_RESPONSE)).mockResolvedValueOnce(
      grpcWebResponse(
        encodeGetRemainingResetsResponse([
          {
            tokenId: 'restok_vpYDqo',
            grantedAt: Date.parse('2026-08-12T18:49:00.000Z'),
            expiresAt: Date.parse('2026-09-12T18:49:00.000Z')
          }
        ])
      )
    )

    const result = await fetchGrokRateLimits()

    expect(result.rateLimitResetCredits).toEqual({
      availableCount: 1,
      nextExpiresAt: Date.parse('2026-09-12T18:49:00.000Z'),
      credits: [
        {
          status: 'available',
          grantedAt: Date.parse('2026-08-12T18:49:00.000Z'),
          expiresAt: Date.parse('2026-09-12T18:49:00.000Z')
        }
      ]
    })
    expect(netFetchMock).toHaveBeenCalledWith(
      GROK_REMAINING_RESETS_URL,
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('surfaces inventory authentication failures in the Grok snapshot', async () => {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse(BILLING_RESPONSE))
      .mockResolvedValueOnce(grpcWebResponse(new Uint8Array(), '16'))

    const result = await fetchGrokRateLimits()

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/inventory unauthorized/)
    })
  })

  it('keeps the prior inventory through a transient inventory failure', async () => {
    const previousRateLimitResetCredits = { availableCount: 2, nextExpiresAt: 123 }
    netFetchMock
      .mockResolvedValueOnce(jsonResponse(BILLING_RESPONSE))
      .mockResolvedValueOnce(grpcWebResponse(new Uint8Array(), '13'))

    const result = await fetchGrokRateLimits({
      previousRateLimitResetCredits,
      previousAuthAccountId: 'user-1'
    })

    expect(result).toMatchObject({
      status: 'ok',
      rateLimitResetCredits: previousRateLimitResetCredits
    })
  })

  it("does not retain another account's inventory after a switch", async () => {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse(BILLING_RESPONSE))
      .mockResolvedValueOnce(grpcWebResponse(new Uint8Array(), '13'))

    const result = await fetchGrokRateLimits({
      previousRateLimitResetCredits: { availableCount: 2, nextExpiresAt: 123 },
      previousAuthAccountId: 'user-2'
    })

    expect(result.rateLimitResetCredits).toBeUndefined()
  })
})
