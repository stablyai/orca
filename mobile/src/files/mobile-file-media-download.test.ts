import { Buffer } from 'buffer/index.js'
import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import {
  downloadMobileFileMedia,
  MOBILE_MEDIA_CHUNK_BYTES,
  MOBILE_MEDIA_MAX_BYTES
} from './mobile-file-media-download'

const media = {
  worktreeId: 'folder-workspace',
  relativePath: 'clips/demo.mp4',
  mimeType: 'video/mp4'
}
const ok = (result: unknown): RpcResponse => ({
  id: '1',
  ok: true,
  result,
  _meta: { runtimeId: 'host' }
})
const stat = (size: number, mtime = 1, ctime?: number) =>
  ok({ size, mtime, ctime, isDirectory: false, futureField: true })
const chunk = (bytes: Uint8Array, eof: boolean) =>
  ok({ contentBase64: Buffer.from(bytes).toString('base64'), bytesRead: bytes.length, eof })
function rig(replies: RpcResponse[]) {
  const client = {
    sendRequest: vi.fn(async (_method: string, _params?: unknown, _options?: unknown) => {
      const reply = replies.shift()
      if (!reply) {
        throw new Error('Unexpected request')
      }
      return reply
    })
  }
  const sink = { append: vi.fn(), finish: vi.fn(() => 'file:///cache/media.mp4'), dispose: vi.fn() }
  const controller = new AbortController()
  const progress = vi.fn()
  return {
    client,
    sink,
    controller,
    progress,
    run: () => downloadMobileFileMedia(client, media, sink, controller.signal, progress)
  }
}

describe('mobile media download', () => {
  it.each(['forbidden', 'method_not_found'])(
    'explains when an older host refuses media stat: %s',
    async (code) => {
      const r = rig([
        {
          id: '1',
          ok: false,
          error: { code, message: 'Unavailable' },
          _meta: { runtimeId: 'host' }
        }
      ])
      await expect(r.run()).rejects.toThrow('Update Orca on your desktop')
      expect(r.client.sendRequest).toHaveBeenCalledTimes(1)
      expect(r.sink.dispose).toHaveBeenCalledOnce()
    }
  )
  it('stages bounded chunks byte-for-byte and verifies the file after downloading', async () => {
    const bytes = new Uint8Array(MOBILE_MEDIA_CHUNK_BYTES + 3).fill(123)
    const r = rig([
      stat(bytes.length),
      chunk(bytes.subarray(0, MOBILE_MEDIA_CHUNK_BYTES), false),
      chunk(bytes.subarray(MOBILE_MEDIA_CHUNK_BYTES), true),
      stat(bytes.length)
    ])
    expect(await r.run()).toBe('file:///cache/media.mp4')
    expect(r.client.sendRequest.mock.calls.map((call) => call[0])).toEqual([
      'files.stat',
      'files.readChunk',
      'files.readChunk',
      'files.stat'
    ])
    expect(r.sink.append).toHaveBeenNthCalledWith(
      1,
      Buffer.from(bytes.subarray(0, MOBILE_MEDIA_CHUNK_BYTES))
    )
    expect(r.sink.append).toHaveBeenNthCalledWith(
      2,
      Buffer.from(bytes.subarray(MOBILE_MEDIA_CHUNK_BYTES))
    )
    expect(r.progress).toHaveBeenLastCalledWith(bytes.length, bytes.length)
    expect(r.sink.dispose).not.toHaveBeenCalled()
  })
  it('refuses oversized files before requesting any bytes', async () => {
    const r = rig([stat(MOBILE_MEDIA_MAX_BYTES + 1)])
    await expect(r.run()).rejects.toThrow('256 MB')
    expect(r.client.sendRequest).toHaveBeenCalledTimes(1)
    expect(r.sink.append).not.toHaveBeenCalled()
    expect(r.sink.dispose).toHaveBeenCalledOnce()
  })
  it.each([
    { contentBase64: 'AA==', bytesRead: 3, eof: true },
    { contentBase64: '', bytesRead: 0, eof: false },
    { contentBase64: 'AA==', bytesRead: 1, eof: true },
    { contentBase64: 'AAAAAA==', bytesRead: 4, eof: true },
    { contentBase64: '$invalid', bytesRead: 3, eof: true }
  ])('discards a malformed or truncated transfer: %j', async (invalid) => {
    const r = rig([stat(3), ok(invalid)])
    await expect(r.run()).rejects.toThrow()
    expect(r.sink.append).not.toHaveBeenCalled()
    expect(r.sink.finish).not.toHaveBeenCalled()
    expect(r.sink.dispose).toHaveBeenCalledOnce()
  })
  it('refuses a file modified while it was downloaded', async () => {
    const r = rig([stat(3), chunk(new Uint8Array(3), true), stat(3, 2)])
    await expect(r.run()).rejects.toThrow('File changed')
    expect(r.sink.finish).not.toHaveBeenCalled()
    expect(r.sink.dispose).toHaveBeenCalledOnce()
  })
  it('rejects a multi-chunk rewrite that restores the modification time and size', async () => {
    const first = new Uint8Array(MOBILE_MEDIA_CHUNK_BYTES).fill(1)
    const second = new Uint8Array(3).fill(2)
    const size = first.length + second.length
    const r = rig([stat(size, 1, 2), chunk(first, false), chunk(second, true), stat(size, 1, 3)])
    await expect(r.run()).rejects.toThrow('File changed')
    expect(r.sink.append).toHaveBeenCalledTimes(2)
    expect(r.sink.finish).not.toHaveBeenCalled()
    expect(r.sink.dispose).toHaveBeenCalledOnce()
  })
  it('accepts an unchanged write timestamp and rejects its disappearance', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const unchanged = rig([stat(3, 1, 2), chunk(bytes, true), stat(3, 1, 2)])
    expect(await unchanged.run()).toBe('file:///cache/media.mp4')
    const missing = rig([stat(3, 1, 2), chunk(bytes, true), stat(3)])
    await expect(missing.run()).rejects.toThrow('File changed')
    expect(missing.sink.dispose).toHaveBeenCalledOnce()
  })
  it('never writes or requests another chunk after cancellation during a pending read', async () => {
    const r = rig([stat(3)])
    r.client.sendRequest
      .mockImplementationOnce(async () => stat(3))
      .mockImplementationOnce(async () => {
        r.controller.abort()
        return chunk(new Uint8Array(3), true)
      })
    await expect(r.run()).rejects.toThrow('cancelled')
    expect(r.client.sendRequest).toHaveBeenCalledTimes(2)
    expect(r.sink.append).not.toHaveBeenCalled()
    expect(r.sink.dispose).toHaveBeenCalledOnce()
  })
  it('discards cached bytes when the owning host disconnects', async () => {
    const r = rig([
      stat(3),
      {
        id: '1',
        ok: false,
        error: { code: 'disconnected', message: 'SSH provider unavailable' },
        _meta: { runtimeId: 'host' }
      }
    ])
    await expect(r.run()).rejects.toThrow('SSH provider unavailable')
    expect(r.sink.dispose).toHaveBeenCalledOnce()
  })
})
