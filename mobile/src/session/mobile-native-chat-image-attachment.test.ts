import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse, RpcSuccess } from '../transport/types'
import { uploadMobileNativeChatImage } from './mobile-native-chat-image-attachment'

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

describe('uploadMobileNativeChatImage', () => {
  it('uploads the picked image and returns its host path + local preview uri, without any terminal.send', async () => {
    const client = clientWithResponses([
      methodNotFound('start'),
      ok('save', '/tmp/orca-attach.png')
    ])

    const result = await uploadMobileNativeChatImage('library', {
      client,
      getConnectionId: async () => 'conn-7',
      pickImage: vi.fn().mockResolvedValue({ base64: 'AAAA', uri: 'file:///photo.jpg' })
    })

    expect(result).toEqual({ path: '/tmp/orca-attach.png', previewUri: 'file:///photo.jpg' })
    // Native chat defers the paste to submit — nothing is sent to the terminal here.
    expect(client.calls.some((call) => call.method === 'terminal.send')).toBe(false)
    const saveCall = client.calls.find((c) => c.method === 'clipboard.saveImageAsTempFile')
    expect(saveCall?.params).toMatchObject({ connectionId: 'conn-7' })
  })

  it('returns null when the picker is cancelled and uploads nothing', async () => {
    const client = clientWithResponses([])

    const result = await uploadMobileNativeChatImage('library', {
      client,
      getConnectionId: async () => null,
      pickImage: vi.fn().mockResolvedValue(null)
    })

    expect(result).toBeNull()
    expect(client.calls).toEqual([])
  })

  it('falls back to an inline data uri for the preview when the picker omits a uri', async () => {
    const client = clientWithResponses([methodNotFound('start'), ok('save', '/tmp/x.png')])

    const result = await uploadMobileNativeChatImage('files', {
      client,
      getConnectionId: async () => null,
      pickImage: vi.fn().mockResolvedValue({ base64: 'BBBB' })
    })

    expect(result).toEqual({ path: '/tmp/x.png', previewUri: 'data:image/png;base64,BBBB' })
  })

  it('signals upload start only after a real image is picked', async () => {
    const onUploadStart = vi.fn()
    const cancelledClient = clientWithResponses([])
    await uploadMobileNativeChatImage('library', {
      client: cancelledClient,
      getConnectionId: async () => null,
      pickImage: vi.fn().mockResolvedValue(null),
      onUploadStart
    })
    expect(onUploadStart).not.toHaveBeenCalled()

    const client = clientWithResponses([methodNotFound('start'), ok('save', '/tmp/y.png')])
    await uploadMobileNativeChatImage('library', {
      client,
      getConnectionId: async () => null,
      pickImage: vi.fn().mockResolvedValue({ base64: 'CCCC', uri: 'file:///y.jpg' }),
      onUploadStart
    })
    expect(onUploadStart).toHaveBeenCalledTimes(1)
  })
})
