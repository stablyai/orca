import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { sendMobileNativeChatPermissionResponse } from './mobile-native-chat-permission-send'

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
