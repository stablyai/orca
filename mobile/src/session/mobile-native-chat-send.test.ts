import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import {
  MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS,
  openMobileNativeChatSendBudget,
  clearMobileNativeChatInput,
  sendMobileNativeChatMessage,
  sendMobileNativeChatMessageWithOutcome,
  typeMobileNativeChatCommandWithOutcome
} from './mobile-native-chat-send'
import { buildAgentTuiClearInputForText } from '../../../src/shared/agent-tui-input-clear'

afterEach(() => vi.useRealTimers())

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
        resolvedLaunchDraft: { text: 'seed', createdAt: 7 },
        mobileClient: { id: 'device', type: 'mobile' }
      })
    ).resolves.toBe(true)
    expect(client.sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      {
        terminal: 'term',
        text: 'hello',
        enter: true,
        resolvedLaunchDraft: { text: 'seed', createdAt: 7 },
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

  it('never bundles terminal controls into the submitted body', async () => {
    const client = clientWithResponse({
      id: 'request',
      ok: true,
      result: { send: { accepted: true } },
      _meta: { runtimeId: 'runtime' }
    })

    await sendMobileNativeChatMessage({
      client,
      terminal: 'term',
      text: 'hello'
    })
    expect(client.sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      {
        terminal: 'term',
        text: 'hello',
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
      text: 'what is this'
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

describe('typeMobileNativeChatCommandWithOutcome', () => {
  it('writes the Codex picker command as keys instead of one pasted text write', async () => {
    vi.useFakeTimers()
    const client = clientWithResponse({
      id: 'request',
      ok: true,
      result: { send: { accepted: true } },
      _meta: { runtimeId: 'runtime' }
    })
    const result = typeMobileNativeChatCommandWithOutcome({
      client,
      terminal: 'term',
      command: '/model'
    })
    await vi.runAllTimersAsync()

    await expect(result).resolves.toBe('accepted')
    expect(
      vi.mocked(client.sendRequest).mock.calls.map((call) => {
        const params = call[1] as { text: string; enter: boolean }
        return { text: params.text, enter: params.enter }
      })
    ).toEqual(
      ['\x15', '/', 'm', 'o', 'd', 'e', 'l', '\r'].map((text) => ({
        text,
        enter: false
      }))
    )
  })

  it('retires a parked launch draft only with the final typed Enter', async () => {
    vi.useFakeTimers()
    const client = clientWithResponse({
      id: 'request',
      ok: true,
      result: { send: { accepted: true } },
      _meta: { runtimeId: 'runtime' }
    })
    const result = typeMobileNativeChatCommandWithOutcome({
      client,
      terminal: 'term',
      command: '/model',
      resolvedLaunchDraft: { text: 'seed', createdAt: 7 }
    })
    await vi.runAllTimersAsync()
    await result

    const params = vi.mocked(client.sendRequest).mock.calls.map((call) => call[1]) as Array<{
      text: string
      resolvedLaunchDraft?: { text: string; createdAt: number }
    }>
    expect(params.slice(0, -1).every((entry) => entry.resolvedLaunchDraft === undefined)).toBe(true)
    expect(params.at(-1)).toMatchObject({
      text: '\r',
      resolvedLaunchDraft: { text: 'seed', createdAt: 7 }
    })
  })
})

describe('clearMobileNativeChatInput', () => {
  const accepted = {
    id: 'request',
    ok: true,
    result: { send: { accepted: true } },
    _meta: { runtimeId: 'runtime' }
  }
  const params = (client: RpcClient) =>
    vi.mocked(client.sendRequest).mock.calls[0]![1] as { text: string; enter: boolean }

  it('writes the burst as its OWN non-submitting write', async () => {
    // Bundling the burst into the body write reached the agent as LITERAL Ctrl+U
    // text and the parked draft concatenated (observed live).
    const client = clientWithResponse(accepted)
    const clearInput = buildAgentTuiClearInputForText('Linked Linear issue: ABC-123\nhttps://x')
    await expect(
      clearMobileNativeChatInput({ client, terminal: 'term', clearInput })
    ).resolves.toBe(true)
    expect(params(client)).toMatchObject({ text: clearInput, enter: false })
  })

  it('reports failure when the host rejects the clear', async () => {
    const client = clientWithResponse({
      id: 'request',
      ok: true,
      result: { send: { accepted: false } },
      _meta: { runtimeId: 'runtime' }
    })
    await expect(
      clearMobileNativeChatInput({ client, terminal: 'term', clearInput: '\x15' })
    ).resolves.toBe(false)
  })

  it('refuses to start an underfunded clear rather than half-clearing', async () => {
    const client = clientWithResponse(accepted)
    await expect(
      clearMobileNativeChatInput({
        client,
        terminal: 'term',
        clearInput: '\x15',
        deadline: Date.now() + 10
      })
    ).resolves.toBe(false)
    expect(client.sendRequest).not.toHaveBeenCalled()
  })
})
