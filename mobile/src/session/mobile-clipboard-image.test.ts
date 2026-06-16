import { describe, expect, it, vi } from 'vitest'
import {
  buildMobileImagePastePayload,
  MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS,
  normalizeMobileClipboardImageBase64,
  saveMobileClipboardImageAsTempFile
} from './mobile-clipboard-image'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'

function ok(id: string, result: unknown): RpcSuccess {
  return { id, ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function fail(id: string, code: string, message: string): RpcFailure {
  return { id, ok: false, error: { code, message }, _meta: { runtimeId: 'runtime-1' } }
}

function clientWithResponses(responses: RpcResponse[]): Pick<RpcClient, 'sendRequest'> & {
  calls: Array<{ method: string; params: unknown }>
} {
  const calls: Array<{ method: string; params: unknown }> = []
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

describe('mobile clipboard image paste helpers', () => {
  it('strips data URL image prefixes', () => {
    expect(normalizeMobileClipboardImageBase64('data:image/png;base64,aGVsbG8=')).toBe('aGVsbG8=')
  })

  it('rejects non-base64 image data', () => {
    expect(() => normalizeMobileClipboardImageBase64('not base64!')).toThrow(
      'Clipboard image content must be base64'
    )
  })

  it('uploads mobile clipboard images in ordered chunks and commits', async () => {
    const base64 = 'a'.repeat(MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS + 4)
    const client = clientWithResponses([
      ok('start', { uploadId: 'upload-1' }),
      ok('append-1', { receivedBase64Length: MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS }),
      ok('append-2', { receivedBase64Length: base64.length }),
      ok('commit', '/tmp/orca-paste-image.png')
    ])

    await expect(
      saveMobileClipboardImageAsTempFile(client, `data:image/png;base64,${base64}`, {
        connectionId: 'ssh-1'
      })
    ).resolves.toBe('/tmp/orca-paste-image.png')

    expect(client.calls).toEqual([
      {
        method: 'clipboard.startImageUpload',
        params: { expectedBase64Length: base64.length, connectionId: 'ssh-1' }
      },
      {
        method: 'clipboard.appendImageUploadChunk',
        params: {
          uploadId: 'upload-1',
          offset: 0,
          contentBase64: base64.slice(0, MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS)
        }
      },
      {
        method: 'clipboard.appendImageUploadChunk',
        params: {
          uploadId: 'upload-1',
          offset: MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS,
          contentBase64: base64.slice(MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS)
        }
      },
      { method: 'clipboard.commitImageUpload', params: { uploadId: 'upload-1' } }
    ])
  })

  it('falls back to the legacy single-frame image save method when needed', async () => {
    const client = clientWithResponses([
      fail('start', 'method_not_found', 'missing'),
      ok('save', '/tmp/orca-paste-image.png')
    ])

    await expect(saveMobileClipboardImageAsTempFile(client, 'aGVsbG8=')).resolves.toBe(
      '/tmp/orca-paste-image.png'
    )

    expect(client.calls).toEqual([
      {
        method: 'clipboard.startImageUpload',
        params: { expectedBase64Length: 8, connectionId: null }
      },
      {
        method: 'clipboard.saveImageAsTempFile',
        params: { contentBase64: 'aGVsbG8=', connectionId: null }
      }
    ])
  })

  it('aborts chunked upload state when append fails', async () => {
    const client = clientWithResponses([
      ok('start', { uploadId: 'upload-1' }),
      fail('append', 'invalid_argument', 'bad chunk'),
      ok('abort', { aborted: true })
    ])

    await expect(saveMobileClipboardImageAsTempFile(client, 'aGVsbG8=')).rejects.toThrow(
      'bad chunk'
    )
    expect(client.calls.at(-1)).toEqual({
      method: 'clipboard.abortImageUpload',
      params: { uploadId: 'upload-1' }
    })
  })

  it('brackets generated image paths before sending to the terminal', () => {
    expect(buildMobileImagePastePayload('/tmp/orca.png')).toBe('\x1b[200~/tmp/orca.png\x1b[201~')
    expect(buildMobileImagePastePayload('/tmp/\x1b.png')).toBe('\x1b[200~/tmp/\u241b.png\x1b[201~')
  })
})
