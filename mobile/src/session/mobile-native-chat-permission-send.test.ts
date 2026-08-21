import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS } from './mobile-native-chat-send'
import {
  sendMobileNativeChatPermissionResponse,
  useMobileNativeChatPermissionSend
} from './mobile-native-chat-permission-send'
import {
  isMobileNativeChatInputStale,
  markMobileNativeChatInputStale,
  resetMobileNativeChatStaleInputForTests
} from './mobile-native-chat-stale-input'
import {
  acquireMobileNativeChatTerminalWrite,
  releaseMobileNativeChatTerminalWrite,
  resetMobileNativeChatTerminalWritesForTests
} from './mobile-native-chat-terminal-write-lock'

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
    expect(sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      {
        terminal: 'terminal',
        text: '1',
        enter: false,
        client: { id: 'phone', type: 'mobile' }
      },
      { timeoutMs: MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS, budgetSpansConnect: true }
    )
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
    resetMobileNativeChatStaleInputForTests()
    resetMobileNativeChatTerminalWritesForTests()
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

  it('rejects a choice while another composed write holds the terminal, then recovers', async () => {
    const onSendError = vi.fn()
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
        onSendError
      })
      return null
    }
    act(() => {
      renderer = create(createElement(Harness))
    })

    // An image paste sequence is mid-flight into the same PTY: the choice
    // keystroke must not interleave into it.
    expect(acquireMobileNativeChatTerminalWrite('terminal')).toBe(true)
    await act(async () => {
      await expect(respond?.('1')).resolves.toBe(false)
    })
    expect(sendRequest).not.toHaveBeenCalled()
    expect(onSendError).toHaveBeenCalledWith('Response not sent')

    releaseMobileNativeChatTerminalWrite('terminal')
    await act(async () => {
      await expect(respond?.('1')).resolves.toBe(true)
    })
    // The choice released its own hold on the way out.
    expect(acquireMobileNativeChatTerminalWrite('terminal')).toBe(true)
    releaseMobileNativeChatTerminalWrite('terminal')
  })
})
