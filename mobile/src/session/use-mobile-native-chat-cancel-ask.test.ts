import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { useMobileNativeChatCancelAsk } from './use-mobile-native-chat-cancel-ask'

let renderer: ReactTestRenderer | undefined
afterEach(() => act(() => renderer?.unmount()))

function fixture() {
  const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue({
    id: 'send',
    ok: true,
    result: { send: { accepted: true } }
  })
  const client: RpcClient = {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  const cancelPending = vi.fn()
  const onSendError = vi.fn()
  let cancelAsk: (() => Promise<boolean>) | undefined
  function Probe(): null {
    cancelAsk = useMobileNativeChatCancelAsk({
      client,
      enabled: true,
      handleRef: { current: 'terminal' },
      deviceTokenRef: { current: 'device' },
      cancelPending,
      onSendError
    })
    return null
  }
  act(() => {
    renderer = create(createElement(Probe))
  })
  return {
    sendRequest,
    cancelPending,
    onSendError,
    cancel: () => {
      if (!cancelAsk) {
        throw new Error('Cancel hook did not mount')
      }
      return cancelAsk()
    }
  }
}

describe('mobile question rejection', () => {
  it('cancels pending answer writes then sends exactly one Escape without submitting', async () => {
    const f = fixture()
    await expect(f.cancel()).resolves.toBe(true)
    expect(f.cancelPending).toHaveBeenCalledOnce()
    const sends = f.sendRequest.mock.calls.filter(([method]) => method === 'terminal.send')
    expect(sends).toHaveLength(1)
    expect(sends[0]?.[1]).toMatchObject({ terminal: 'terminal', text: '\x1b', enter: false })
    expect(f.onSendError).not.toHaveBeenCalled()
  })

  it('reports ambiguous rejection delivery without retrying into a changed selector', async () => {
    const f = fixture()
    f.sendRequest.mockRejectedValue(markRpcDeliveryUnknown(new Error('connection lost')))
    await expect(f.cancel()).resolves.toBe(false)
    expect(f.sendRequest).toHaveBeenCalledOnce()
    expect(f.onSendError).toHaveBeenCalledWith('Cancel unconfirmed — check chat before retrying')
  })
})
