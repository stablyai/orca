import { describe, expect, it, vi } from 'vitest'

import {
  buildMobileTerminalImagePastePayload,
  saveMobileClipboardImageAsTempFile
} from './mobile-clipboard-image'

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
})
