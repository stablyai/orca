import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'

import type { RpcClient } from '../../transport/rpc-client'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../../transport/types'
import { uploadMobileAgentSessionAttachment } from './mobile-agent-session-attachment-upload'

function ok(result: unknown): RpcSuccess {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function fail(message: string): RpcFailure {
  return {
    id: 'r',
    ok: false,
    error: { code: 'failed', message },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function fakeHost(answer: (method: string, params: unknown) => RpcResponse) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const client: Pick<RpcClient, 'sendRequest'> = {
    sendRequest: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params: Object.fromEntries(Object.entries(params ?? {})) })
      return answer(method, params)
    })
  }
  return { client, calls }
}

function storingHost(byteLength = 3, name = 'spec.pdf', failAppend = false) {
  return fakeHost((method) => {
    if (method === 'agentSessionAttachment.uploadStart') {
      return ok({ uploadId: 'upload-1' })
    }
    if (method === 'agentSessionAttachment.uploadAppend') {
      return failAppend ? fail('disk full') : ok({})
    }
    if (method === 'agentSessionAttachment.uploadCommit') {
      return ok({ path: `/store/upload-1/${name}`, name, byteLength })
    }
    return ok({ aborted: true })
  })
}

describe('uploadMobileAgentSessionAttachment', () => {
  it('sends an empty file as one empty append', async () => {
    const host = storingHost(0, 'empty.txt')
    await uploadMobileAgentSessionAttachment(host.client, {
      sessionId: 'session-1',
      name: 'empty.txt',
      base64: ''
    })
    expect(host.calls.map((call) => call.method)).toEqual([
      'agentSessionAttachment.uploadStart',
      'agentSessionAttachment.uploadAppend',
      'agentSessionAttachment.uploadCommit'
    ])
    expect(host.calls[0]?.params.byteLength).toBe(0)
    expect(host.calls[1]).toEqual({
      method: 'agentSessionAttachment.uploadAppend',
      params: { uploadId: 'upload-1', offset: 0, contentBase64: '' }
    })
  })

  it("aborts the slot when a chunk fails and reports the host's reason", async () => {
    const host = storingHost(3, 'spec.pdf', true)
    await expect(
      uploadMobileAgentSessionAttachment(host.client, {
        sessionId: 'session-1',
        name: 'spec.pdf',
        base64: Buffer.from('abc').toString('base64')
      })
    ).rejects.toThrow('disk full')
    expect(host.calls.at(-1)).toEqual({
      method: 'agentSessionAttachment.uploadAbort',
      params: { uploadId: 'upload-1' }
    })
  })

  it('opens no slot to abort when the host refuses the start', async () => {
    const host = fakeHost(() => fail('Attachment is too large'))
    await expect(
      uploadMobileAgentSessionAttachment(host.client, {
        sessionId: 'session-1',
        name: 'big.bin',
        base64: 'AAAA'
      })
    ).rejects.toThrow('Attachment is too large')
    expect(host.calls.map((call) => call.method)).toEqual(['agentSessionAttachment.uploadStart'])
  })
})
