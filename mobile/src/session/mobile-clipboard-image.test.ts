import { describe, expect, it, vi } from 'vitest'
import { AppendImageUploadChunk } from '../../../src/shared/rpc-contract/clipboard-params'
import {
  buildMobileImagePastePayload,
  buildMobileTerminalImagePastePayload,
  computeMobileClipboardImageDownscale,
  MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS,
  normalizeMobileClipboardImageBase64,
  prepareMobileClipboardImageBase64,
  saveMobileClipboardImageAsTempFile
} from './mobile-clipboard-image'
import type { RpcClient } from '../transport/rpc-client'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
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

    for (const call of client.calls) {
      if (call.method === 'clipboard.appendImageUploadChunk') {
        expect(AppendImageUploadChunk.safeParse(call.params).success).toBe(true)
      }
    }

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

  it('restarts the upload after a logical connection cutover', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(ok('start-1', { uploadId: 'upload-1' }))
      .mockRejectedValueOnce(new LogicalClientCutoverError())
      .mockResolvedValueOnce(ok('abort-1', { aborted: true }))
      .mockResolvedValueOnce(ok('start-2', { uploadId: 'upload-2' }))
      .mockResolvedValueOnce(ok('append-2', { receivedBase64Length: 8 }))
      .mockResolvedValueOnce(ok('commit-2', '/tmp/orca-paste-image.png'))

    await expect(saveMobileClipboardImageAsTempFile({ sendRequest }, 'aGVsbG8=')).resolves.toBe(
      '/tmp/orca-paste-image.png'
    )

    expect(sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'clipboard.startImageUpload',
      'clipboard.appendImageUploadChunk',
      'clipboard.abortImageUpload',
      'clipboard.startImageUpload',
      'clipboard.appendImageUploadChunk',
      'clipboard.commitImageUpload'
    ])
  })

  it('brackets generated image paths before sending to the terminal', () => {
    expect(buildMobileImagePastePayload('/tmp/orca.png', 'claude')).toBe(
      '\x1b[200~/tmp/orca.png\x1b[201~'
    )
    expect(buildMobileImagePastePayload('/tmp/\x1b.png', 'claude')).toBe(
      '\x1b[200~/tmp/\u241b.png\x1b[201~'
    )
  })

  it('escapes spaced paths for Codex and unidentified terminals', () => {
    const escaped = '\x1b[200~/tmp/or\\ ca.png\x1b[201~'
    expect(buildMobileTerminalImagePastePayload('/tmp/or ca.png', 'codex')).toBe(escaped)
    expect(buildMobileTerminalImagePastePayload('/tmp/or ca.png', null)).toBe(escaped)
    expect(buildMobileTerminalImagePastePayload('/tmp/or ca.png', undefined)).toBe(escaped)
    expect(buildMobileTerminalImagePastePayload('/tmp/or ca.png', 'unknown')).toBe(escaped)
    expect(buildMobileTerminalImagePastePayload('/tmp/\x1b.png', null)).toBe(
      '\x1b[200~/tmp/\u241b.png\x1b[201~'
    )
  })

  it('keeps file mentions for agents that need them', () => {
    const mention = '\x1b[200~@"/tmp/or ca.png"\x1b[201~'
    expect(buildMobileTerminalImagePastePayload('/tmp/or ca.png', 'opencode')).toBe(mention)
    expect(buildMobileImagePastePayload('/tmp/or ca.png', null)).toBe(mention)
  })

  it.each([null, 'unknown', 'codex', 'omp'])(
    'contains embedded paste markers inside the image paste for %s',
    (agent) => {
      const payload = buildMobileTerminalImagePastePayload(
        '/tmp/image\x1b[201~\ncommand\x1b[200~.png',
        agent
      )
      expect(payload.split('\x1b')).toHaveLength(3)
      expect(payload.startsWith('\x1b[200~')).toBe(true)
      expect(payload.endsWith('\x1b[201~')).toBe(true)
      expect(payload).toContain('image\u241b[201~\ncommand\u241b[200~.png')
    }
  )

  it('quotes Windows paths with spaces using the host path dialect', () => {
    expect(
      buildMobileTerminalImagePastePayload('C:\\Users\\Jane Doe\\Temp\\orca-paste.png', null)
    ).toBe('\x1b[200~"C:\\Users\\Jane Doe\\Temp\\orca-paste.png"\x1b[201~')
  })
})

describe('mobile clipboard image downscaling', () => {
  it('does not downscale images already within the byte budget', () => {
    expect(computeMobileClipboardImageDownscale(50, 100, 100, 100)).toBeNull()
  })

  it('shrinks both edges by ~sqrt(budget/actual) when over the budget', () => {
    expect(computeMobileClipboardImageDownscale(400, 40, 20, 100)).toEqual({ width: 17, height: 8 })
  })

  it('refuses to downscale when source dimensions are unusable', () => {
    expect(computeMobileClipboardImageDownscale(400, 0, 20, 100)).toBeNull()
    expect(computeMobileClipboardImageDownscale(400, 40, -1, 100)).toBeNull()
  })

  it('returns the original base64 untouched when within budget', async () => {
    const resize = vi.fn()
    const data = `data:image/png;base64,${'a'.repeat(40)}`
    await expect(
      prepareMobileClipboardImageBase64({ data, size: { width: 10, height: 10 } }, resize, 100)
    ).resolves.toBe(data)
    expect(resize).not.toHaveBeenCalled()
  })

  it('downscales oversized images in one pass when the result fits', async () => {
    const resize = vi.fn(async () => ({ data: 'b'.repeat(50), width: 17, height: 8 }))
    const data = `data:image/png;base64,${'a'.repeat(400)}`
    await expect(
      prepareMobileClipboardImageBase64({ data, size: { width: 40, height: 20 } }, resize, 100)
    ).resolves.toBe('b'.repeat(50))
    expect(resize).toHaveBeenCalledTimes(1)
    expect(resize).toHaveBeenCalledWith(data, { width: 17, height: 8 })
  })

  it('retries downscaling, feeding back result dimensions, until it fits', async () => {
    const resize = vi
      .fn()
      .mockResolvedValueOnce({ data: 'b'.repeat(150), width: 17, height: 8 })
      .mockResolvedValueOnce({ data: 'c'.repeat(40), width: 7, height: 3 })
    const data = `data:image/png;base64,${'a'.repeat(400)}`
    await expect(
      prepareMobileClipboardImageBase64({ data, size: { width: 40, height: 20 } }, resize, 100)
    ).resolves.toBe('c'.repeat(40))
    expect(resize).toHaveBeenCalledTimes(2)
    expect(resize.mock.calls[1][0]).toBe('b'.repeat(150))
    expect(resize.mock.calls[1][1]).toEqual({ width: 11, height: 5 })
  })

  it('gives up after bounded attempts and lets the downstream cap reject it', async () => {
    const resize = vi.fn(async () => ({ data: 'b'.repeat(150), width: 5, height: 5 }))
    const data = `data:image/png;base64,${'a'.repeat(400)}`
    await expect(
      prepareMobileClipboardImageBase64({ data, size: { width: 40, height: 20 } }, resize, 100)
    ).resolves.toBe('b'.repeat(150))
    expect(resize).toHaveBeenCalledTimes(3)
  })
})
