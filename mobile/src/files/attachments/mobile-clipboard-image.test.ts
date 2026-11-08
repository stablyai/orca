import { describe, expect, it, vi } from 'vitest'

import {
  buildMobileImagePastePayload,
  buildMobileTerminalImagePastePayload,
  normalizeMobileClipboardImageBase64,
  saveMobileClipboardImageAsTempFile
} from './mobile-clipboard-image'
import { computeMobileClipboardImageDownscale } from './mobile-clipboard-image-downscale'

import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import '../../transport/connection/stable-logical-rpc-client'
import '../../transport/connection/logical-client-cutover-error'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../../transport/rpc/rpc-wire-types'

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
})
