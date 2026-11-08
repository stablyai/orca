import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { RpcResponse, RpcSuccess } from '../../../transport/rpc/rpc-wire-types'
import { uploadMobileNativeChatImages } from './mobile-native-chat-image-attachment'

function ok(id: string, result: unknown): RpcSuccess {
  return { id, ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function methodNotFound(id: string): RpcResponse {
  return {
    id,
    ok: false,
    error: { code: 'method_not_found', message: 'no' },
    _meta: { runtimeId: 'r' }
  }
}

function clientWithResponses(responses: RpcResponse[]): Pick<RpcClient, 'sendRequest'> & {
  calls: { method: string; params: unknown }[]
} {
  const calls: { method: string; params: unknown }[] = []
  return {
    calls,
    sendRequest: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      const response = responses.shift()
      if (!response) {
        throw new Error(`unexpected request: ${method}`)
      }
      return response
    })
  }
}

describe('uploadMobileNativeChatImages', () => {
  it('uploads all three selected images in picker order', async () => {
    const client = clientWithResponses([
      methodNotFound('start-a'),
      ok('save-a', '/tmp/a.png'),
      methodNotFound('start-b'),
      ok('save-b', '/tmp/b.png'),
      methodNotFound('start-c'),
      ok('save-c', '/tmp/c.png')
    ])

    const order: string[] = []
    async function* pickImages() {
      for (const image of [
        { base64: 'AAAA', uri: 'file:///a.jpg' },
        { base64: 'BBBB', uri: 'file:///b.jpg' },
        { base64: 'CCCC', uri: 'file:///c.jpg' }
      ]) {
        order.push(`read:${image.uri}`)
        yield image
      }
    }
    const result = await uploadMobileNativeChatImages('library', {
      client,
      getConnectionId: async () => 'conn-7',
      pickImages,
      onImageUploaded: (image) => order.push(`uploaded:${image.previewUri}`)
    })

    expect(result).toEqual([
      {
        path: '/tmp/a.png',
        previewUri: 'file:///a.jpg'
      },
      {
        path: '/tmp/b.png',
        previewUri: 'file:///b.jpg'
      },
      {
        path: '/tmp/c.png',
        previewUri: 'file:///c.jpg'
      }
    ])
    expect(order).toEqual([
      'read:file:///a.jpg',
      'uploaded:file:///a.jpg',
      'read:file:///b.jpg',
      'uploaded:file:///b.jpg',
      'read:file:///c.jpg',
      'uploaded:file:///c.jpg'
    ])
  })

  it('returns an empty array when the picker is cancelled and uploads nothing', async () => {
    const client = clientWithResponses([])

    const result = await uploadMobileNativeChatImages('library', {
      client,
      getConnectionId: async () => null,
      pickImages: vi.fn().mockResolvedValue([])
    })

    expect(result).toEqual([])
    expect(client.calls).toEqual([])
  })

  it('falls back to an inline data uri for the preview when the picker omits a uri', async () => {
    const client = clientWithResponses([methodNotFound('start'), ok('save', '/tmp/x.png')])

    const result = await uploadMobileNativeChatImages('files', {
      client,
      getConnectionId: async () => null,
      pickImages: vi.fn().mockResolvedValue([{ base64: 'BBBB' }])
    })

    expect(result).toEqual([
      {
        path: '/tmp/x.png',
        previewUri: 'data:image/png;base64,BBBB'
      }
    ])
  })
})
