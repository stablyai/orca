import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import {
  sendMobileNativeChatMessage,
  sendMobileNativeChatMessageWithOutcome
} from './mobile-native-chat-send'

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

  it('reports a definite rejection when the RPC failed before the frame was written', async () => {
    const client = {
      sendRequest: vi.fn().mockRejectedValue(new Error('Connection interrupted'))
    } as unknown as RpcClient

    await expect(
      sendMobileNativeChatMessageWithOutcome({ client, terminal: 'term', text: 'hello' })
    ).resolves.toBe('rejected')
  })

  it('reports an unknown outcome when the RPC failed after the frame hit the wire', async () => {
    const client = {
      sendRequest: vi
        .fn()
        .mockRejectedValue(markRpcDeliveryUnknown(new Error('Connection interrupted')))
    } as unknown as RpcClient

    await expect(
      sendMobileNativeChatMessageWithOutcome({ client, terminal: 'term', text: 'hello' })
    ).resolves.toBe('unknown')
    // The boolean wrapper still treats unknown as not-accepted.
    await expect(
      sendMobileNativeChatMessage({ client, terminal: 'term', text: 'hello' })
    ).resolves.toBe(false)
  })

  it('reports acceptance and host rejection as definite outcomes', async () => {
    const accepted = clientWithResponse({
      id: 'request',
      ok: true,
      result: { send: { accepted: true } },
      _meta: { runtimeId: 'runtime' }
    })
    await expect(
      sendMobileNativeChatMessageWithOutcome({ client: accepted, terminal: 'term', text: 'hi' })
    ).resolves.toBe('accepted')

    const rejected = clientWithResponse({
      id: 'request',
      ok: false,
      error: { message: 'no pane' },
      _meta: { runtimeId: 'runtime' }
    })
    await expect(
      sendMobileNativeChatMessageWithOutcome({ client: rejected, terminal: 'term', text: 'hi' })
    ).resolves.toBe('rejected')
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
