import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

import {
  consumeGrokRateLimitResetCreditFromRpc,
  encodeGetRemainingResetsResponse,
  encodeGrpcWebMessage,
  encodeRedeemResetRequest,
  GROK_REDEEM_RESET_URL,
  GROK_REMAINING_RESETS_URL,
  mapGrokRedeemGrpcStatus
} from './grok-reset-credit-client'
import type { GrokAuthSession } from './grok-auth'

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

describe('Grok reset redemption protocol', () => {
  it('matches the public RedeemReset token_id field 10 wire encoding', () => {
    expect(Buffer.from(encodeRedeemResetRequest('restok_INVALID')).toString('hex')).toBe(
      '520e726573746f6b5f494e56414c4944'
    )
  })

  it('maps success and the captured redeem error codes', () => {
    expect(mapGrokRedeemGrpcStatus('0', null)).toBe('reset')
    expect(
      mapGrokRedeemGrpcStatus('9', 'The token cannot be redeemed: it does not exist or is expired')
    ).toBe('noCredit')
    expect(mapGrokRedeemGrpcStatus('9', 'The token was already redeemed')).toBe('alreadyRedeemed')
    expect(mapGrokRedeemGrpcStatus('3', 'redeem_reset(), Invalid token_id')).toBe('noCredit')
    expect(() => mapGrokRedeemGrpcStatus('13', 'Unexpected EOF decoding stream.')).toThrow(
      /Unexpected EOF/
    )
  })

  it('redeems the soonest-expiring remaining token', async () => {
    const request = vi.fn(async (url: string, _init: RequestInit) => {
      if (url === GROK_REMAINING_RESETS_URL) {
        return grpcResponse(
          encodeGetRemainingResetsResponse([
            {
              tokenId: 'restok_later',
              grantedAt: null,
              expiresAt: Date.parse('2026-09-20T00:00:00.000Z')
            },
            {
              tokenId: 'restok_soon',
              grantedAt: null,
              expiresAt: Date.parse('2026-09-12T00:00:00.000Z')
            }
          ])
        )
      }
      return grpcResponse(new Uint8Array())
    })

    await expect(consumeGrokRateLimitResetCreditFromRpc(session, { request })).resolves.toBe(
      'reset'
    )
    const redeemCall = request.mock.calls.find(([url]) => url === GROK_REDEEM_RESET_URL)
    expect(redeemCall).toBeDefined()
    const body = new Uint8Array(redeemCall?.[1].body as Uint8Array<ArrayBuffer>)
    expect(Buffer.from(body).toString('hex')).toContain(
      Buffer.from(encodeRedeemResetRequest('restok_soon')).toString('hex')
    )
  })

  it('returns noCredit when the inventory is empty', async () => {
    const request = vi.fn(async () => grpcResponse(new Uint8Array()))
    await expect(consumeGrokRateLimitResetCreditFromRpc(session, { request })).resolves.toBe(
      'noCredit'
    )
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('maps status 9 without a redeemed message to noCredit', async () => {
    await expect(
      consumeGrokRateLimitResetCreditFromRpc(session, {
        tokenId: 'restok_INVALID',
        request: async () => grpcResponse(new Uint8Array(), '9')
      })
    ).resolves.toBe('noCredit')
  })
})
