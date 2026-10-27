import { describe, expect, it, vi } from 'vitest'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { isRenderableImageUri, readStoredChatImage } from './mobile-native-chat-image-preview'

describe('isRenderableImageUri', () => {
  it('accepts local previews and real URLs the device can load', () => {
    for (const uri of [
      'file:///var/mobile/a.jpg',
      'FILE:///var/mobile/a.jpg',
      'HTTPS://host/a.png',
      'data:image/png;base64,AAAA',
      'content://media/1',
      'blob:abc',
      'http://host/a.png',
      'https://host/a.png'
    ]) {
      expect(isRenderableImageUri(uri)).toBe(true)
    }
  })

  it('rejects bare host paths (not loadable on the device) and empty values', () => {
    for (const uri of [
      '/tmp/orca-attach.png',
      'C:\\tmp\\a.png',
      'orca-attach.png',
      '',
      undefined
    ]) {
      expect(isRenderableImageUri(uri)).toBe(false)
    }
  })
})

describe('readStoredChatImage', () => {
  it('reads two images at a time and drops reads whose row went away while queued', async () => {
    const replies: ((reply: RpcResponse) => void)[] = []
    const sendRequest = vi.fn<RpcClient['sendRequest']>(
      () => new Promise<RpcResponse>((resolve) => replies.push(resolve))
    )
    const client = stubRpcClient({ sendRequest })
    const gone = new AbortController()
    const reads = [
      readStoredChatImage(client, '/a.png', new AbortController().signal),
      readStoredChatImage(client, '/b.png', new AbortController().signal),
      readStoredChatImage(client, '/c.png', gone.signal),
      readStoredChatImage(client, '/d.png', new AbortController().signal)
    ]
    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(2))
    gone.abort()
    replies[0]!({ id: '1', ok: false, error: { code: 'forbidden', message: 'refused' } })
    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(3))
    expect(sendRequest.mock.calls.map((call) => call[1])).toEqual([
      { path: '/a.png' },
      { path: '/b.png' },
      { path: '/d.png' }
    ])
    replies[1]!({ id: '2', ok: false, error: { code: 'forbidden', message: 'refused' } })
    replies[2]!({ id: '3', ok: false, error: { code: 'forbidden', message: 'refused' } })
    await expect(Promise.all(reads)).resolves.toEqual([null, null, null, null])
  })
})
