import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

import { PROGRAM_STATUS_QUERY_REPLY } from '../../../src/shared/program-status/protocol'
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
        hostSupportsProgramStatus: true,
        subscribedTerminals
      })
    ).resolves.toBe(false)
    expect(client.sendRequest).not.toHaveBeenCalled()
  })

  // Older hosts strip inputKind and would treat query replies as floor-taking user input.
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
        hostSupportsProgramStatus: true,
        subscribedTerminals: new Set(['terminal-1'])
      })
    ).resolves.toBe(false)
    expect(client.sendRequest).not.toHaveBeenCalled()
  })

  it('does not answer program status for a host that cannot read its reports', async () => {
    const client = createClient()

    await expect(
      sendMobileTerminalQueryReply({
        bytes: PROGRAM_STATUS_QUERY_REPLY,
        client,
        clientId: 'mobile-1',
        connected: true,
        handle: 'terminal-1',
        hostSupportsQueryReplyInput: true,
        hostSupportsProgramStatus: false,
        subscribedTerminals: new Set(['terminal-1'])
      })
    ).resolves.toBe(false)
    expect(client.sendRequest).not.toHaveBeenCalled()
  })
})
