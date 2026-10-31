import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'

import { useMobileNativeChatStop } from './use-mobile-native-chat-stop'

describe('useMobileNativeChatStop', () => {
  let renderer: ReactTestRenderer | null = null
  let stop: (() => Promise<boolean>) | null = null
  const sendRequest = vi.fn()
  const onSendError = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    sendRequest.mockReset().mockResolvedValue({
      ok: true,
      result: { send: { accepted: true } }
    })
    onSendError.mockReset()
    agent = 'opencode'
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    stop = null
    vi.useRealTimers()
  })

  let agent = 'opencode'

  function Harness({
    enabled,
    streamIdentity
  }: {
    enabled: boolean
    streamIdentity: string
  }): null {
    stop = useMobileNativeChatStop({
      client: { sendRequest } as unknown as RpcClient,
      enabled,
      handleRef: { current: 'terminal-1' },
      deviceTokenRef: { current: 'mobile-1' },
      agentRef: { current: agent },
      streamIdentity,
      cancelPending: vi.fn(),
      onSendError
    })
    return null
  }

  async function render(enabled: boolean, streamIdentity: string): Promise<void> {
    await act(async () => {
      const element = createElement(Harness, { enabled, streamIdentity })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  }

  it.each([
    ['the acknowledged input lease is lost', false, 'stream-1'],
    ['the active stream changes', true, 'stream-2']
  ])('cancels the delayed second Escape when %s', async (_case, enabled, streamIdentity) => {
    await render(true, 'stream-1')

    act(() => void stop?.())
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await render(enabled as boolean, streamIdentity as string)
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it.each<[string, number]>([
    ['claude', 1],
    ['codex', 1],
    ['opencode', 2]
  ])('sends %s %i Escape(s) per Stop like desktop', async (stopAgent, count) => {
    agent = stopAgent
    await render(true, 'stream-1')

    act(() => void stop?.())
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(sendRequest).toHaveBeenCalledTimes(count)
  })

  it.each([
    ['a definite rejection', new Error('disconnected'), false],
    ['a lost ack', markRpcDeliveryUnknown(new Error('rpc timeout')), true]
  ])(
    'settles the Stop as possibly sent only when it was not refused: %s',
    async (_case, error, sent) => {
      agent = 'claude'
      sendRequest.mockRejectedValue(error)
      await render(true, 'stream-1')

      let verdict: Promise<boolean> | undefined
      act(() => {
        verdict = stop?.()
      })
      await act(async () => {
        await vi.runAllTimersAsync()
      })

      await expect(verdict).resolves.toBe(sent)
    }
  )

  it('handles a rejected Escape without leaking an unhandled rejection', async () => {
    sendRequest.mockRejectedValue(new Error('disconnected'))
    await render(true, 'stream-1')

    act(() => void stop?.())
    await act(async () => {
      await Promise.resolve()
      await vi.runAllTimersAsync()
    })

    expect(onSendError).toHaveBeenCalledOnce()
    expect(onSendError).toHaveBeenCalledWith('Stop not sent')
  })

  it.each([
    ['RPC failure', { ok: false, error: { code: 'stale', message: 'stale' } }],
    ['non-accepted send', { ok: true, result: { send: { accepted: false } } }]
  ])('reports Stop not sent after a resolved %s', async (_case, response) => {
    sendRequest.mockResolvedValue(response)
    await render(true, 'stream-1')

    act(() => void stop?.())
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(onSendError).toHaveBeenCalledOnce()
    expect(onSendError).toHaveBeenCalledWith('Stop not sent')
  })

  it.each([
    [
      'an ack lost after the frame was written',
      () => markRpcDeliveryUnknown(new Error('rpc timeout'))
    ],
    ['a logical client cutover', () => new Error('RPC interrupted by connection migration')]
  ])('reports Stop as unconfirmed after %s', async (_case, makeError) => {
    sendRequest.mockRejectedValue(makeError())
    await render(true, 'stream-1')

    act(() => void stop?.())
    await act(async () => {
      await Promise.resolve()
      await vi.runAllTimersAsync()
    })

    // Uncertain Escape may have landed; definite failure would invite another into changed state.
    expect(onSendError).toHaveBeenCalledOnce()
    expect(onSendError).toHaveBeenCalledWith('Stop unconfirmed — check chat before retrying')
  })

  it.each([
    ['second', 0],
    ['first', 1]
  ])('stays quiet when the %s Escape fails after its sibling landed', async (_case, failIndex) => {
    let call = 0
    sendRequest.mockImplementation(() => {
      const index = call
      call += 1
      return index === failIndex
        ? Promise.reject(markRpcDeliveryUnknown(new Error('rpc timeout')))
        : Promise.resolve({ ok: true, result: { send: { accepted: true } } })
    })
    await render(true, 'stream-1')

    act(() => void stop?.())
    await act(async () => {
      await Promise.resolve()
      await vi.runAllTimersAsync()
    })

    // Treat paced Escapes as one Stop: either landing suppresses a later failure that would invite duplicate Stop.
    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(onSendError).not.toHaveBeenCalled()
  })

  it('suppresses an older Stop verdict after a newer Stop succeeds', async () => {
    let rejectFirst!: (error: Error) => void
    const first = new Promise((_, reject) => {
      rejectFirst = reject
    })
    sendRequest
      .mockReturnValueOnce(first)
      .mockResolvedValue({ ok: true, result: { send: { accepted: true } } })
    await render(true, 'stream-1')

    act(() => void stop?.())
    act(() => void stop?.())
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    await act(async () => {
      rejectFirst(new Error('late failure'))
      await Promise.resolve()
    })

    expect(onSendError).not.toHaveBeenCalled()
  })
})
