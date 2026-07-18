import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { sendMobileNativeChatMessage } from './mobile-native-chat-send'

function clientWithResponse(response: unknown): RpcClient {
  return {
    sendRequest: vi.fn().mockResolvedValue(response)
  } as unknown as RpcClient
}

describe('sendMobileNativeChatMessage', () => {
  it('returns true only when the terminal accepts the send', async () => {
    const client = clientWithResponse({
      id: 'request',
      ok: true,
      result: { send: { accepted: true } },
      _meta: { runtimeId: 'runtime' }
    })

    await expect(
      sendMobileNativeChatMessage({
        client,
        terminal: 'term',
        text: 'hello',
        mobileClient: { id: 'device', type: 'mobile' }
      })
    ).resolves.toBe(true)
    expect(client.sendRequest).toHaveBeenCalledWith('terminal.send', {
      terminal: 'term',
      text: 'hello',
      enter: true,
      client: { id: 'device', type: 'mobile' }
    })
  })

  it('returns false when the terminal rejects the send', async () => {
    const client = clientWithResponse({
      id: 'request',
      ok: true,
      result: { send: { accepted: false } },
      _meta: { runtimeId: 'runtime' }
    })

    await expect(
      sendMobileNativeChatMessage({ client, terminal: 'term', text: 'hello' })
    ).resolves.toBe(false)
  })

  it('returns false when the RPC fails', async () => {
    const client = {
      sendRequest: vi.fn().mockRejectedValue(new Error('disconnected'))
    } as unknown as RpcClient

    await expect(
      sendMobileNativeChatMessage({ client, terminal: 'term', text: 'hello' })
    ).resolves.toBe(false)
  })

  it('sends a single non-submitting Escape for prompt cancellation', async () => {
    const client = clientWithResponse({
      id: 'request',
      ok: true,
      result: { send: { accepted: true } },
      _meta: { runtimeId: 'runtime' }
    })

    await sendMobileNativeChatMessage({
      client,
      terminal: 'term',
      text: String.fromCharCode(27),
      enter: false
    })
    expect(client.sendRequest).toHaveBeenCalledWith('terminal.send', {
      terminal: 'term',
      text: String.fromCharCode(27),
      enter: false
    })
  })
})
