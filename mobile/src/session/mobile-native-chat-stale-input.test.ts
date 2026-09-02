import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  clearMobileNativeChatInputStale,
  healMobileNativeChatStaleInput,
  isMobileNativeChatInputStale,
  markMobileNativeChatInputStale,
  resetMobileNativeChatStaleInputForTests
} from './mobile-native-chat-stale-input'

function sendResult(accepted: boolean) {
  return {
    id: 'send',
    ok: true as const,
    result: { send: { accepted } },
    _meta: { runtimeId: 'runtime' }
  }
}

function makeClient(accepted = true): Pick<RpcClient, 'sendRequest'> {
  return { sendRequest: vi.fn().mockResolvedValue(sendResult(accepted)) }
}

describe('mobile native chat stale input markers', () => {
  beforeEach(() => {
    resetMobileNativeChatStaleInputForTests()
  })

  it('tracks each terminal independently', () => {
    markMobileNativeChatInputStale('term-1')
    expect(isMobileNativeChatInputStale('term-1')).toBe(true)
    expect(isMobileNativeChatInputStale('term-2')).toBe(false)
    clearMobileNativeChatInputStale('term-1')
    expect(isMobileNativeChatInputStale('term-1')).toBe(false)
  })

  it('writes nothing when the terminal is not marked', async () => {
    const client = makeClient()
    await expect(
      healMobileNativeChatStaleInput({ client, terminal: 'term-1', deviceToken: null })
    ).resolves.toBe(true)
    expect(client.sendRequest).not.toHaveBeenCalled()
  })

  it('clears the line and consumes the marker', async () => {
    const client = makeClient()
    markMobileNativeChatInputStale('term-1')
    await expect(
      healMobileNativeChatStaleInput({ client, terminal: 'term-1', deviceToken: 'device' })
    ).resolves.toBe(true)
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
    expect(vi.mocked(client.sendRequest).mock.calls[0]?.[1]).toMatchObject({
      terminal: 'term-1',
      text: '\x15',
      enter: false,
      client: { id: 'device', type: 'mobile' }
    })
    expect(isMobileNativeChatInputStale('term-1')).toBe(false)
  })

  it('keeps the marker when the host rejects the clear', async () => {
    const client = makeClient(false)
    markMobileNativeChatInputStale('term-1')
    await expect(
      healMobileNativeChatStaleInput({ client, terminal: 'term-1', deviceToken: null })
    ).resolves.toBe(false)
    expect(isMobileNativeChatInputStale('term-1')).toBe(true)
  })

  it('keeps the marker when the clear throws', async () => {
    const client = { sendRequest: vi.fn().mockRejectedValue(new Error('offline')) }
    markMobileNativeChatInputStale('term-1')
    await expect(
      healMobileNativeChatStaleInput({ client, terminal: 'term-1', deviceToken: null })
    ).resolves.toBe(false)
    expect(isMobileNativeChatInputStale('term-1')).toBe(true)
  })
})
