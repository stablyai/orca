import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  net: { fetch: vi.fn() }
}))

import {
  decodeRemainingResetTokens,
  encodeGetRemainingResetsResponse,
  encodeGrpcWebMessage,
  encodeGrpcWebRequest,
  fetchGrokRateLimitResetCredits,
  GROK_REMAINING_RESETS_URL,
  mapRemainingResetTokens,
  parseGrpcWebResponse,
  supplementGrokRateLimitResetCredits
} from './grok-reset-credit-client'
import type { GrokAuthSession } from './grok-auth'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'

const LIVE_REMAINING_RESETS_HEX =
  '5221520d726573746f6b5f76705944716fa20106089c80f3d306f20106089cbd96d506'

const session: GrokAuthSession = {
  accessToken: 'access-token',
  userId: 'user-1',
  email: 'dev@example.com',
  teamId: null,
  expiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
  oidcClientId: null
}

function grpcResponse(payload: Uint8Array<ArrayBufferLike>, grpcStatus = '0'): Response {
  const body = encodeGrpcWebMessage(payload, grpcStatus)
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/grpc-web+proto' }),
    arrayBuffer: async () => body.slice().buffer
  } as Response
}

describe('Grok remaining-reset protobuf', () => {
  it('decodes the live GetRemainingResets payload', () => {
    const tokens = decodeRemainingResetTokens(Buffer.from(LIVE_REMAINING_RESETS_HEX, 'hex'))
    expect(tokens).toEqual([
      {
        tokenId: 'restok_vpYDqo',
        grantedAt: Date.parse('2026-08-12T18:49:00.000Z'),
        expiresAt: Date.parse('2026-09-12T18:49:00.000Z')
      }
    ])
    expect(mapRemainingResetTokens(tokens)).toEqual({
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
  })

  it('round-trips remaining reset tokens', () => {
    const encoded = encodeGetRemainingResetsResponse([
      {
        tokenId: 'restok_vpYDqo',
        grantedAt: Date.parse('2026-08-12T18:49:00.000Z'),
        expiresAt: Date.parse('2026-09-12T18:49:00.000Z')
      }
    ])
    expect(Buffer.from(encoded).toString('hex')).toBe(LIVE_REMAINING_RESETS_HEX)
  })

  it('parses grpc-web trailers for status', () => {
    const raw = encodeGrpcWebMessage(new Uint8Array(), '9')
    expect(parseGrpcWebResponse(raw)).toMatchObject({
      grpcStatus: '9',
      payload: new Uint8Array()
    })
  })

  it('frames an empty GetRemainingResets request as a data-only grpc-web frame', () => {
    expect(Buffer.from(encodeGrpcWebRequest(new Uint8Array())).toString('hex')).toBe('0000000000')
  })

  it.each([
    ['fixed64', Uint8Array.of(0x09, 0, 0, 0)],
    ['fixed32', Uint8Array.of(0x0d, 0, 0, 0)]
  ])('rejects a truncated %s protobuf field', (_wireType, payload) => {
    expect(() => decodeRemainingResetTokens(payload)).toThrow(/Truncated fixed/)
  })

  it.each([
    ['header', Uint8Array.of(0, 0)],
    ['payload', Uint8Array.of(0, 0, 0, 0, 1)],
    ['high-bit length', Uint8Array.of(0, 0x80, 0, 0, 0)]
  ])('rejects a truncated gRPC-Web %s', (_part, payload) => {
    expect(() => parseGrpcWebResponse(payload)).toThrow(/Truncated gRPC-Web/)
  })

  it('rejects a response without grpc-status', () => {
    expect(() => parseGrpcWebResponse(encodeGrpcWebRequest(new Uint8Array()))).toThrow(
      'Missing grpc-status'
    )
  })
})

describe('fetchGrokRateLimitResetCredits', () => {
  it('maps a remaining-reset inventory onto rateLimitResetCredits', async () => {
    const request = vi.fn(async (_url: string, _init: RequestInit) =>
      grpcResponse(
        encodeGetRemainingResetsResponse([
          {
            tokenId: 'restok_vpYDqo',
            grantedAt: Date.parse('2026-08-12T18:49:00.000Z'),
            expiresAt: Date.parse('2026-09-12T18:49:00.000Z')
          }
        ])
      )
    )
    const credits = await fetchGrokRateLimitResetCredits(session, { request })
    expect(credits?.availableCount).toBe(1)
    expect(request).toHaveBeenCalledWith(
      GROK_REMAINING_RESETS_URL,
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer access-token',
          'X-XAI-Token-Auth': 'xai-grok-cli',
          'Content-Type': 'application/grpc-web+proto',
          'x-grpc-web': '1'
        }
      })
    )
  })

  it('returns an empty inventory when no tokens remain', async () => {
    const credits = await fetchGrokRateLimitResetCredits(session, {
      request: async () => grpcResponse(new Uint8Array())
    })
    expect(credits).toEqual({ availableCount: 0, nextExpiresAt: null })
  })

  it('surfaces an authentication error from remaining-reset inventory', async () => {
    await expect(
      fetchGrokRateLimitResetCredits(session, {
        request: async () => grpcResponse(new Uint8Array(), '16')
      })
    ).rejects.toThrow(/inventory unauthorized/)
  })
})

describe('supplementGrokRateLimitResetCredits', () => {
  it('leaves non-ok Grok snapshots unchanged', async () => {
    const limits: ProviderRateLimits = {
      provider: 'grok',
      session: null,
      weekly: null,
      updatedAt: 1,
      error: 'failed',
      status: 'error'
    }
    const request = vi.fn()
    await expect(supplementGrokRateLimitResetCredits(limits, session, { request })).resolves.toBe(
      limits
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps the previous inventory through a transient inventory failure', async () => {
    const limits: ProviderRateLimits = {
      provider: 'grok',
      session: null,
      weekly: null,
      updatedAt: 2,
      error: null,
      status: 'ok',
      usageMetadata: {
        authProvenance: 'dev@example.com (SuperGrok)',
        authAccountId: 'user-1'
      }
    }
    const previousRateLimitResetCredits = { availableCount: 2, nextExpiresAt: 123 }

    await expect(
      supplementGrokRateLimitResetCredits(limits, session, {
        previousRateLimitResetCredits,
        previousAuthAccountId: 'user-1',
        request: async () => grpcResponse(new Uint8Array(), '13')
      })
    ).resolves.toEqual({ ...limits, rateLimitResetCredits: previousRateLimitResetCredits })
  })

  it('discards the previous inventory after an account switch', async () => {
    const limits: ProviderRateLimits = {
      provider: 'grok',
      session: null,
      weekly: null,
      updatedAt: 2,
      error: null,
      status: 'ok',
      usageMetadata: {
        authProvenance: 'dev@example.com (SuperGrok)',
        authAccountId: 'user-1'
      }
    }

    await expect(
      supplementGrokRateLimitResetCredits(limits, session, {
        previousRateLimitResetCredits: { availableCount: 2, nextExpiresAt: 123 },
        previousAuthAccountId: 'user-2',
        request: async () => grpcResponse(new Uint8Array(), '13')
      })
    ).resolves.toEqual(limits)
  })
})
