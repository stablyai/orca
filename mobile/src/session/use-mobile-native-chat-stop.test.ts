import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileNativeChatStop } from './use-mobile-native-chat-stop'

describe('useMobileNativeChatStop', () => {
  let renderer: ReactTestRenderer | null = null
  let stop: (() => void) | null = null
  const sendRequest = vi.fn()
  const onSendError = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    sendRequest.mockReset().mockResolvedValue({ ok: true })
    onSendError.mockReset()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    stop = null
    vi.useRealTimers()
  })

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

    act(() => stop?.())
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await render(enabled as boolean, streamIdentity as string)
    await act(async () => vi.runAllTimersAsync())

    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('handles a rejected Escape without leaking an unhandled rejection', async () => {
    sendRequest.mockRejectedValue(new Error('disconnected'))
    await render(true, 'stream-1')

    act(() => stop?.())
    await act(async () => {
      await Promise.resolve()
      await vi.runAllTimersAsync()
    })

    expect(onSendError).toHaveBeenCalledOnce()
    expect(onSendError).toHaveBeenCalledWith('Stop not sent')
  })
})
