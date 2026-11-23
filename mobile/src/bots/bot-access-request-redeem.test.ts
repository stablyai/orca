import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import { redeemBotAccessRequest } from './bot-access-request-redeem'

const TOKEN = 'a'.repeat(43)

function client(reply: RpcResponse | Error, sent: unknown[] = []): RpcClient {
  return {
    sendRequest: (method: string, params: unknown) => {
      sent.push({ method, params })
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)
    },
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: (): ConnectionState => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
}

function result(value: unknown): RpcResponse {
  const reply: RpcResponse = { id: 'redeem', ok: true, result: value }
  return reply
}

describe('redeemBotAccessRequest', () => {
  it('sends only the token, since today’s links name no bot', async () => {
    const sent: unknown[] = []
    await redeemBotAccessRequest(client(result({ kind: 'not-here' }), sent), TOKEN)
    expect(sent).toEqual([{ method: 'bots.access.redeem', params: { token: TOKEN } }])
  })

  it('passes the host’s answer through', async () => {
    await expect(
      redeemBotAccessRequest(client(result({ kind: 'redeemed', botId: 'atlas' })), TOKEN)
    ).resolves.toEqual({ kind: 'redeemed', botId: 'atlas' })
    await expect(
      redeemBotAccessRequest(client(result({ kind: 'not-here' })), TOKEN)
    ).resolves.toEqual({ kind: 'not-here' })
  })

  it('reads a refusal, a lost connection or a malformed answer as failed', async () => {
    const refused: RpcResponse = {
      id: 'redeem',
      ok: false,
      error: { code: 'forbidden', message: 'no' }
    }
    await expect(redeemBotAccessRequest(client(refused), TOKEN)).resolves.toEqual({
      kind: 'failed'
    })
    await expect(redeemBotAccessRequest(client(new Error('closed')), TOKEN)).resolves.toEqual({
      kind: 'failed'
    })
    await expect(
      redeemBotAccessRequest(client(result({ kind: 'later-kind' })), TOKEN)
    ).resolves.toEqual({ kind: 'failed' })
  })
})
