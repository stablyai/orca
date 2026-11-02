import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../transport/rpc-client'
import { retryHeldHermesSubmit } from './mobile-hermes-held-submit'

const send = vi.hoisted(() => vi.fn())
vi.mock('./mobile-native-chat-send', () => ({ sendMobileNativeChatMessageWithOutcome: send }))
afterEach(() => {
  vi.useRealTimers()
  send.mockReset()
})

describe('retryHeldHermesSubmit', () => {
  it('retries once when the exact draft remains on two screen reads', async () => {
    vi.useFakeTimers()
    const read = vi
      .fn()
      .mockResolvedValue({ ok: true, result: { terminal: { source: 'screen', draft: 'hello' } } })
    const task = retryHeldHermesSubmit({
      // SAFETY: The retry reads only sendRequest from this client.
      client: { sendRequest: read } as unknown as RpcClient,
      terminal: 't',
      text: 'hello',
      deadline: Date.now() + 10_000,
      deviceToken: null,
      isCurrent: () => true
    })
    await vi.runAllTimersAsync()
    await task
    expect(read).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]?.[0]).toMatchObject({ text: '', enter: true })
  })

  it('never retries when the draft changes between reads', async () => {
    vi.useFakeTimers()
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        result: { terminal: { source: 'screen', draft: 'hello' } }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { terminal: { source: 'screen', draft: 'other' } }
      })
    const task = retryHeldHermesSubmit({
      // SAFETY: The retry reads only sendRequest from this client.
      client: { sendRequest: read } as unknown as RpcClient,
      terminal: 't',
      text: 'hello',
      deadline: Date.now() + 10_000,
      deviceToken: null,
      isCurrent: () => true
    })
    await vi.runAllTimersAsync()
    await task
    expect(send).not.toHaveBeenCalled()
  })

  it.each(['hello  world', 'hello world '])(
    'does not retry a draft edited to differ only in whitespace: %j',
    async (draft) => {
      vi.useFakeTimers()
      const read = vi.fn().mockResolvedValue({
        ok: true,
        result: { terminal: { source: 'screen', draft } }
      })
      const task = retryHeldHermesSubmit({
        // SAFETY: The retry reads only sendRequest from this client.
        client: { sendRequest: read } as unknown as RpcClient,
        terminal: 't',
        text: 'hello world',
        deadline: Date.now() + 10_000,
        deviceToken: null,
        isCurrent: () => true
      })
      await vi.runAllTimersAsync()
      await task
      expect(send).not.toHaveBeenCalled()
    }
  )
})
