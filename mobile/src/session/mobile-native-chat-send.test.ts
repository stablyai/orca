import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import {
  MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS,
  openMobileNativeChatSendBudget,
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
    expect(client.sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      {
        terminal: 'term',
        text: 'hello',
        enter: true,
        client: { id: 'device', type: 'mobile' }
      },
      { timeoutMs: MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS, budgetSpansConnect: true }
    )
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

  it('reports an unknown outcome when the request timeout expires', async () => {
    // The request-timeout path: the frame was written and only the ack is missing,
    // so calling it "Message not sent" would hide a message the desktop received.
    const client = {
      sendRequest: vi
        .fn()
        .mockRejectedValue(markRpcDeliveryUnknown(new Error('Request timed out: terminal.send')))
    } as unknown as RpcClient

    await expect(
      sendMobileNativeChatMessageWithOutcome({ client, terminal: 'term', text: 'hello' })
    ).resolves.toBe('unknown')
  })

  it('reports a definite rejection when the connect wait times out', async () => {
    // The same timeout budget also covers the pre-connect wait, which is deliberately
    // NOT marked delivery-unknown — no frame was ever written.
    const client = {
      sendRequest: vi
        .fn()
        .mockRejectedValue(new Error('Timed out while connecting to the remote Orca runtime.'))
    } as unknown as RpcClient

    await expect(
      sendMobileNativeChatMessageWithOutcome({ client, terminal: 'term', text: 'hello' })
    ).resolves.toBe('rejected')
  })

  it('reports an unknown outcome when a logical cutover interrupts the send', async () => {
    const client = {
      sendRequest: vi.fn().mockRejectedValue(new LogicalClientCutoverError())
    } as unknown as RpcClient

    await expect(
      sendMobileNativeChatMessageWithOutcome({ client, terminal: 'term', text: 'hello' })
    ).resolves.toBe('unknown')
    // The boolean wrapper still treats unknown as not-accepted (never retried here).
    await expect(
      sendMobileNativeChatMessage({ client, terminal: 'term', text: 'hello' })
    ).resolves.toBe(false)
  })

  it('treats a cross-bundle cutover error (matched by message) as unknown', async () => {
    // Why: instanceof can miss across bundle copies, so cutover is also matched
    // by its message — that path must still land on ambiguous, not rejected.
    const client = {
      sendRequest: vi.fn().mockRejectedValue(new Error('RPC interrupted by connection migration'))
    } as unknown as RpcClient

    await expect(
      sendMobileNativeChatMessageWithOutcome({ client, terminal: 'term', text: 'hello' })
    ).resolves.toBe('unknown')
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

  it('prepends the input-line clear byte when clearInputFirst is set', async () => {
    const client = clientWithResponse({
      id: 'request',
      ok: true,
      result: { send: { accepted: true } },
      _meta: { runtimeId: 'runtime' }
    })

    await sendMobileNativeChatMessage({
      client,
      terminal: 'term',
      text: 'hello',
      clearInputFirst: true
    })
    expect(client.sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      {
        terminal: 'term',
        text: '\x15hello',
        enter: true
      },
      { timeoutMs: MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS, budgetSpansConnect: true }
    )
  })

  it('sends the text verbatim when clearInputFirst is not set', async () => {
    // An image send pastes the image (behind its own leading Ctrl+U) before this
    // text write; a clear byte here would kill the pasted image off the input line.
    const client = clientWithResponse({
      id: 'request',
      ok: true,
      result: { send: { accepted: true } },
      _meta: { runtimeId: 'runtime' }
    })

    await sendMobileNativeChatMessage({
      client,
      terminal: 'term',
      text: 'what is this',
      clearInputFirst: false
    })
    const sent = vi.mocked(client.sendRequest).mock.calls[0]?.[1] as { text: string }
    expect(sent.text).toBe('what is this')
    expect(sent.text.startsWith('\x15')).toBe(false)
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
    expect(client.sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      {
        terminal: 'term',
        text: String.fromCharCode(27),
        enter: false
      },
      { timeoutMs: MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS, budgetSpansConnect: true }
    )
  })

  it('spends only what is left of a shared budget', async () => {
    const client = clientWithResponse({
      id: 'request',
      ok: true,
      result: { send: { accepted: true } },
      _meta: { runtimeId: 'runtime' }
    })

    await sendMobileNativeChatMessageWithOutcome({
      client,
      terminal: 'term',
      text: 'hi',
      deadline: Date.now() + 4_000
    })
    const options = vi.mocked(client.sendRequest).mock.calls[0]?.[2] as { timeoutMs: number }
    expect(options.timeoutMs).toBeGreaterThan(3_000)
    expect(options.timeoutMs).toBeLessThanOrEqual(4_000)
  })

  it('refuses a write whose shared budget cannot fund the final acknowledgement', async () => {
    const client = clientWithResponse({
      id: 'request',
      ok: true,
      result: { send: { accepted: true } },
      _meta: { runtimeId: 'runtime' }
    })

    // Nothing reaches the wire, so this is a definite non-send rather than ambiguous.
    await expect(
      sendMobileNativeChatMessageWithOutcome({
        client,
        terminal: 'term',
        text: 'hi',
        deadline: Date.now() + 400
      })
    ).resolves.toBe('rejected')
    expect(client.sendRequest).not.toHaveBeenCalled()
  })

  it('opens a budget bounded by the send timeout', () => {
    const budget = openMobileNativeChatSendBudget() - Date.now()
    expect(budget).toBeGreaterThan(MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS - 1_000)
    expect(budget).toBeLessThanOrEqual(MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS)
  })
})
