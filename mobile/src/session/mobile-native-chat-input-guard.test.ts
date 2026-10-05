import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  createMobileChatInputAction,
  noteMobileChatInputGuard
} from './mobile-native-chat-input-guard'
import {
  MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS,
  sendMobileNativeChatMessageWithOutcome
} from './mobile-native-chat-send'

function clientWithResponse(response: unknown): RpcClient {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the send reads only sendRequest.
  return { sendRequest: vi.fn().mockResolvedValue(response) } as unknown as RpcClient
}

describe('mobile chat input guard', () => {
  it('creates an action only for a host whose latest snapshot advertises the guard', () => {
    const client = clientWithResponse(null)
    expect(createMobileChatInputAction(client)).toBeUndefined()
    noteMobileChatInputGuard(client, true)
    expect(createMobileChatInputAction(client)?.actionId).toMatch(/^chat-/)
    noteMobileChatInputGuard(client, false)
    expect(createMobileChatInputAction(client)).toBeUndefined()
    expect(createMobileChatInputAction(null)).toBeUndefined()
  })

  it('sends the action on the write and reads an agent-exited refusal as not sent', async () => {
    const client = clientWithResponse({
      id: 'request',
      ok: true,
      result: { send: { accepted: false, bytesWritten: 0, refusedReason: 'agent-exited' } },
      _meta: { runtimeId: 'runtime' }
    })
    await expect(
      sendMobileNativeChatMessageWithOutcome({
        client,
        terminal: 'term',
        text: 'hello',
        chatInput: { actionId: 'chat-1' }
      })
    ).resolves.toBe('rejected')
    expect(client.sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      { terminal: 'term', text: 'hello', enter: true, chatInput: { actionId: 'chat-1' } },
      { timeoutMs: MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS, budgetSpansConnect: true }
    )
  })

  it('reads a lost settlement as unconfirmed, so the user is not invited to resend', async () => {
    const client = clientWithResponse({
      id: 'request',
      ok: true,
      result: { send: { accepted: false, bytesWritten: 5, deliveryUnknown: true } },
      _meta: { runtimeId: 'runtime' }
    })
    await expect(
      sendMobileNativeChatMessageWithOutcome({ client, terminal: 'term', text: 'hello' })
    ).resolves.toBe('unknown')
  })

  it('reads a refusal after a settled prefix as unconfirmed, never a clean failure (R1B-3)', async () => {
    const client = clientWithResponse({
      id: 'request',
      ok: true,
      result: { send: { accepted: false, bytesWritten: 4096, refusedReason: 'agent-exited' } },
      _meta: { runtimeId: 'runtime' }
    })
    await expect(
      sendMobileNativeChatMessageWithOutcome({
        client,
        terminal: 'term',
        text: 'hello',
        chatInput: { actionId: 'chat-1' }
      })
    ).resolves.toBe('unknown')
  })
})
