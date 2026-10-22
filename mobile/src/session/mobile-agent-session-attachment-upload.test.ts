import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_ATTACHMENT_CHUNK_BASE64_CHARS,
  AGENT_SESSION_ATTACHMENT_CHUNK_BYTES
} from '../../../src/shared/agent-session-attachments'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'
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

/** A host that answers by method, recording what reached it. */
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

function storingHost(failAppend = false) {
  return fakeHost((method) => {
    if (method === 'agentSessionAttachment.uploadStart') {
      return ok({ uploadId: 'upload-1' })
    }
    if (method === 'agentSessionAttachment.uploadAppend') {
      return failAppend ? fail('disk full') : ok({})
    }
    if (method === 'agentSessionAttachment.uploadCommit') {
      return ok({ path: '/store/upload-1/spec.pdf', name: 'spec.pdf', byteLength: 3 })
    }
    return ok({ aborted: true })
  })
}

describe('uploadMobileAgentSessionAttachment', () => {
  it('stores a file across chunks addressed by byte offset and answers the host path', async () => {
    const bytes = Buffer.alloc(AGENT_SESSION_ATTACHMENT_CHUNK_BYTES * 2 + 5, 7)
    const host = storingHost()

    const stored = await uploadMobileAgentSessionAttachment(host.client, {
      sessionId: 'session-1',
      name: 'spec.pdf',
      base64: bytes.toString('base64')
    })

    expect(stored).toEqual({ path: '/store/upload-1/spec.pdf', name: 'spec.pdf', byteLength: 3 })
    expect(host.calls[0]).toEqual({
      method: 'agentSessionAttachment.uploadStart',
      params: { sessionId: 'session-1', name: 'spec.pdf', byteLength: bytes.byteLength }
    })
    const appends = host.calls.filter(
      (call) => call.method === 'agentSessionAttachment.uploadAppend'
    )
    expect(appends.map((call) => call.params.offset)).toEqual([
      0,
      AGENT_SESSION_ATTACHMENT_CHUNK_BYTES,
      AGENT_SESSION_ATTACHMENT_CHUNK_BYTES * 2
    ])
    const reassembled = Buffer.concat(
      appends.map((call) => Buffer.from(String(call.params.contentBase64), 'base64'))
    )
    expect(reassembled.equals(bytes)).toBe(true)
    expect(
      appends.every(
        (call) =>
          String(call.params.contentBase64).length <= AGENT_SESSION_ATTACHMENT_CHUNK_BASE64_CHARS
      )
    ).toBe(true)
    expect(host.calls.at(-1)?.method).toBe('agentSessionAttachment.uploadCommit')
  })

  it('sends an empty file as one empty append', async () => {
    const host = storingHost()
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
  })

  it("aborts the slot when a chunk fails and reports the host's reason", async () => {
    const host = storingHost(true)
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
