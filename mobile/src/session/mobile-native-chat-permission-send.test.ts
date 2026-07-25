import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import {
  sendMobileNativeChatPermissionResponse,
  useMobileNativeChatPermissionSend
} from './mobile-native-chat-permission-send'
import {
  isMobileNativeChatInputStale,
  markMobileNativeChatInputStale,
  resetMobileNativeChatStaleInputForTests
} from './mobile-native-chat-stale-input'

describe('sendMobileNativeChatPermissionResponse', () => {
  it('writes an approval as raw bytes without appending Return', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: { send: { handle: 'terminal', accepted: true, bytesWritten: 1 } }
    })

    await expect(
      sendMobileNativeChatPermissionResponse({
        client: { sendRequest } as unknown as RpcClient,
        terminal: 'terminal',
        deviceToken: 'phone',
        text: '1'
      })
    ).resolves.toBe('accepted')
    expect(sendRequest).toHaveBeenCalledWith('terminal.send', {
      terminal: 'terminal',
      text: '1',
      enter: false,
      client: { id: 'phone', type: 'mobile' }
    })
  })

  it('surfaces an ambiguous delivery as unknown instead of a definite failure', async () => {
    const sendRequest = vi
      .fn()
      .mockRejectedValue(markRpcDeliveryUnknown(new Error('Connection closed')))

    await expect(
      sendMobileNativeChatPermissionResponse({
        client: { sendRequest } as unknown as RpcClient,
        terminal: 'terminal',
        deviceToken: null,
        text: '1'
      })
    ).resolves.toBe('unknown')
  })
})

describe('useMobileNativeChatPermissionSend', () => {
  let renderer: ReactTestRenderer | null = null
  let respond: ((text: string) => Promise<boolean>) | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    resetMobileNativeChatStaleInputForTests()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    respond = null
  })

  it('keeps the marker for a permission choice, which never submits the composer', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: { send: { handle: 'terminal', accepted: true, bytesWritten: 1 } }
    })
    function Harness(): null {
      respond = useMobileNativeChatPermissionSend({
        client: { sendRequest } as unknown as RpcClient,
        enabled: true,
        handleRef: { current: 'terminal' },
        deviceTokenRef: { current: null },
        onSendError: vi.fn()
      })
      return null
    }
    act(() => {
      renderer = create(createElement(Harness))
    })
    markMobileNativeChatInputStale('terminal')

    await act(async () => {
      await expect(respond?.('1')).resolves.toBe(true)
    })
    // A choice is a bare key for a live overlay that swallows a clear while the
    // host still acks it, so healing here would burn the marker and leave the
    // paste to corrupt the next real message. Only the choice may go.
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ text: '1', enter: false })
    expect(isMobileNativeChatInputStale('terminal')).toBe(true)
  })
})
