import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'

import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../../transport/rpc/rpc-wire-types'
import type { PickedMobileFile } from '../../platform/media-picker-contract'
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

function fileOf(
  parts: readonly string[],
  byteLength = parts.reduce((sum, part) => sum + Buffer.from(part, 'base64').length, 0)
): PickedMobileFile {
  return {
    name: 'spec.pdf',
    mime: 'application/pdf',
    byteLength,
    chunks: async function* () {
      yield* parts.map((part) => Buffer.from(part).toString('base64'))
    }
  }
}

const CHUNK = 393216

describe('uploadMobileAgentSessionAttachment', () => {
  it("aborts the slot when a chunk fails and reports the host's reason", async () => {
    const host = storingHost(3, 'spec.pdf', true)
    await expect(
      uploadMobileAgentSessionAttachment(host.client, {
        sessionId: 'session-1',
        file: fileOf(['abc'])
      })
    ).rejects.toThrow('disk full')
    expect(host.calls.at(-1)).toEqual({
      method: 'agentSessionAttachment.uploadAbort',
      params: { uploadId: 'upload-1' }
    })
  })

  it('uploads each chunk at its byte offset', async () => {
    const host = storingHost()
    const progress: number[] = []
    await uploadMobileAgentSessionAttachment(host.client, {
      sessionId: 'session-1',
      file: fileOf(['a'.repeat(CHUNK), 'b'.repeat(CHUNK), 'c']),
      onProgress: (sent) => progress.push(sent)
    })

    expect(
      host.calls
        .filter((call) => call.method === 'agentSessionAttachment.uploadAppend')
        .map((call) => call.params.offset)
    ).toEqual([0, CHUNK, CHUNK * 2])
    expect(host.calls.at(-1)?.method).toBe('agentSessionAttachment.uploadCommit')
    expect(progress).toEqual([CHUNK, CHUNK * 2, CHUNK * 2 + 1])
  })

  it('sends one empty append for an empty file', async () => {
    const host = storingHost()
    await uploadMobileAgentSessionAttachment(host.client, {
      sessionId: 'session-1',
      file: fileOf([])
    })

    expect(host.calls.map((call) => call.method)).toEqual([
      'agentSessionAttachment.uploadStart',
      'agentSessionAttachment.uploadAppend',
      'agentSessionAttachment.uploadCommit'
    ])
  })

  it('aborts the upload when the signal fires and never commits', async () => {
    const host = storingHost()
    const controller = new AbortController()
    const progress: number[] = []
    const result = uploadMobileAgentSessionAttachment(host.client, {
      sessionId: 'session-1',
      file: fileOf(['a'.repeat(CHUNK), 'b'.repeat(CHUNK)]),
      signal: controller.signal,
      onProgress: (sent) => {
        progress.push(sent)
        if (sent === CHUNK * 2) {
          controller.abort()
        }
      }
    })

    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(progress).toEqual([CHUNK, CHUNK * 2])
    expect(host.calls.map((call) => call.method)).not.toContain(
      'agentSessionAttachment.uploadCommit'
    )
    expect(host.calls.at(-1)?.method).toBe('agentSessionAttachment.uploadAbort')
  })
})
