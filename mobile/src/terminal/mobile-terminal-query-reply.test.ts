import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { sendMobileTerminalQueryReply } from './mobile-terminal-query-reply'

function createClient() {
  return {
    sendRequest: vi.fn<RpcClient['sendRequest']>().mockResolvedValue({
      id: '1',
      ok: true,
      result: { send: { accepted: true, bytesWritten: 6 } },
      _meta: { runtimeId: 'runtime-1' }
    }),
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  } satisfies RpcClient
}

describe('sendMobileTerminalQueryReply', () => {
  it('sends a subscribed terminal reply immediately with additive RPC metadata', async () => {
    const client = createClient()

    await expect(
      sendMobileTerminalQueryReply({
        bytes: '\x1b[3;4R',
        client,
        clientId: 'mobile-1',
        connected: true,
        handle: 'terminal-1',
        hostSupportsQueryReplyInput: true,
        subscribedTerminals: new Set(['terminal-1'])
      })
    ).resolves.toBe(true)

    expect(client.sendRequest).toHaveBeenCalledWith('terminal.send', {
      terminal: 'terminal-1',
      text: '\x1b[3;4R',
      enter: false,
      inputKind: 'query-reply',
      client: { id: 'mobile-1', type: 'mobile' }
    })

    const refused: RpcResponse = {
      id: '2',
      ok: true,
      result: { send: { handle: 'terminal-1', accepted: false, bytesWritten: 0 } }
    }
    client.sendRequest.mockResolvedValueOnce(refused)
    await expect(
      sendMobileTerminalQueryReply({
        bytes: '\x1b[3;4R',
        client,
        clientId: 'mobile-1',
        connected: true,
        handle: 'terminal-1',
        hostSupportsQueryReplyInput: true,
        subscribedTerminals: new Set(['terminal-1'])
      })
    ).resolves.toBe(false)
    expect(client.sendRequest).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['disconnected', false, new Set(['terminal-1']), '\x1b[3;4R', 'terminal-1'],
    ['unsubscribed', true, new Set(), '\x1b[3;4R', 'terminal-1'],
    ['stale handle', true, new Set(['terminal-2']), '\x1b[3;4R', 'terminal-1'],
    ['ordinary input', true, new Set(['terminal-1']), 'a', 'terminal-1']
  ])('does not send %s data', async (_case, connected, subscribedTerminals, bytes, handle) => {
    const client = createClient()

    await expect(
      sendMobileTerminalQueryReply({
        bytes,
        client,
        clientId: 'mobile-1',
        connected,
        handle,
        hostSupportsQueryReplyInput: true,
        subscribedTerminals
      })
    ).resolves.toBe(false)
    expect(client.sendRequest).not.toHaveBeenCalled()
  })

  // Why: hosts without terminal.query-reply-input.v1 strip inputKind (zod drops
  // unknown keys) and would treat the reply as floor-taking shell input.
  it('does not send to a host that has not advertised query-reply input support', async () => {
    const client = createClient()

    await expect(
      sendMobileTerminalQueryReply({
        bytes: '\x1b[3;4R',
        client,
        clientId: 'mobile-1',
        connected: true,
        handle: 'terminal-1',
        hostSupportsQueryReplyInput: false,
        subscribedTerminals: new Set(['terminal-1'])
      })
    ).resolves.toBe(false)
    expect(client.sendRequest).not.toHaveBeenCalled()
  })
})
