import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'

import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import type { PickedMobileFile } from '../../platform/media-picker-contract'
import { MobileFileUploadRefusedError } from './mobile-chunked-file-upload'
import { uploadMobileTerminalFile } from './mobile-terminal-file-upload'

const CHUNK = 393216

function ok(result: unknown): RpcResponse {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function refused(message: string): RpcResponse {
  return {
    id: 'r',
    ok: false,
    error: { code: 'failed', message },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function fakeHost(failSecondAppend = false) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let appends = 0
  const client: Pick<RpcClient, 'sendRequest'> = {
    sendRequest: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params: Object.fromEntries(Object.entries(params ?? {})) })
      if (method === 'terminalFileUpload.start') {
        return ok({ uploadId: 'upload-1' })
      }
      if (method === 'terminalFileUpload.append') {
        appends += 1
        if (failSecondAppend && appends === 2) {
          const failure: RpcResponse = {
            id: 'r',
            ok: false,
            error: { code: 'failed', message: 'disk full' },
            _meta: { runtimeId: 'runtime-1' }
          }
          return failure
        }
        return ok({ receivedLength: 0 })
      }
      if (method === 'terminalFileUpload.commit') {
        return ok({ path: '/tmp/orca-paste-1/lenta.mp4', name: 'lenta.mp4', byteLength: CHUNK * 2 })
      }
      return ok({ aborted: true })
    })
  }
  return { client, calls }
}

const file: PickedMobileFile = {
  name: 'lenta.mp4',
  mime: 'video/mp4',
  byteLength: CHUNK * 2,
  chunks: async function* () {
    yield Buffer.alloc(CHUNK, 1).toString('base64')
    yield Buffer.alloc(CHUNK, 2).toString('base64')
  }
}

describe('uploadMobileTerminalFile', () => {
  it('sends start, byte-offset appends and commit', async () => {
    const host = fakeHost()
    const progress: number[] = []
    const stored = await uploadMobileTerminalFile(host.client, {
      file,
      connectionId: null,
      onProgress: (sent) => progress.push(sent)
    })

    expect(host.calls[0]).toEqual({
      method: 'terminalFileUpload.start',
      params: { name: 'lenta.mp4', byteLength: 786432, connectionId: null }
    })
    expect(
      host.calls
        .filter((call) => call.method === 'terminalFileUpload.append')
        .map((call) => call.params.offset)
    ).toEqual([0, 393216])
    expect(host.calls.at(-1)).toEqual({
      method: 'terminalFileUpload.commit',
      params: { uploadId: 'upload-1' }
    })
    expect(progress).toEqual([CHUNK, CHUNK * 2])
    expect(stored).toMatchObject({ path: '/tmp/orca-paste-1/lenta.mp4' })
  })

  it("aborts on a refused append and reports it as the host's refusal", async () => {
    const host = fakeHost(true)
    const upload = uploadMobileTerminalFile(host.client, { file, connectionId: null })
    await expect(upload).rejects.toBeInstanceOf(MobileFileUploadRefusedError)
    await expect(upload).rejects.toMatchObject({ hostMessage: 'disk full', reason: 'host' })
    expect(host.calls.at(-1)).toEqual({
      method: 'terminalFileUpload.abort',
      params: { uploadId: 'upload-1' }
    })
    expect(host.calls.filter((call) => call.method === 'terminalFileUpload.append')).toHaveLength(2)
  })

  it('reports a refused start for an SSH worktree as the SSH refusal', async () => {
    const client: Pick<RpcClient, 'sendRequest'> = {
      sendRequest: vi.fn(async () => refused('Remote connection dropped'))
    }
    await expect(
      uploadMobileTerminalFile(client, { file, connectionId: 'ssh-1' })
    ).rejects.toMatchObject({ reason: 'ssh-workspace' })
  })

  it('passes a lost connection through rather than as a host refusal', async () => {
    const lost = new Error('Connection interrupted')
    const client: Pick<RpcClient, 'sendRequest'> = {
      sendRequest: vi.fn(async (method: string) => {
        if (method === 'terminalFileUpload.append') {
          throw lost
        }
        return ok({ uploadId: 'upload-1' })
      })
    }
    await expect(uploadMobileTerminalFile(client, { file, connectionId: null })).rejects.toBe(lost)
  })
})
