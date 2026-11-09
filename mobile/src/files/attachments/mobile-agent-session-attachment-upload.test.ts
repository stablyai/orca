import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'

import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../../transport/rpc/rpc-wire-types'
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
})
