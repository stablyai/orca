import { describe, expect, it, vi } from 'vitest'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'
import {
  downloadMobileFileMedia,
  createMobileFileMediaAttempt,
  MEDIA_HANDOFF_CHUNK_BYTES,
  mediaHandoffBase64ByteLength,
  mediaHandoffMimeFor,
  type MobileFileMediaSink
} from './mobile-file-media-handoff'

function ok(result: unknown): RpcSuccess {
  return { id: '1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function fail(message: string, code = 'error'): RpcFailure {
  return { id: '1', ok: false, error: { code, message }, _meta: { runtimeId: 'runtime-1' } }
}

function clientWithResponses(responses: RpcResponse[]) {
  return {
    sendRequest: vi.fn(async () => responses.shift()!)
  }
}

type RecordingSink = MobileFileMediaSink & {
  appends: string[]
  opened: number
  discarded: number
  released: number
}

function recordingSink(): RecordingSink {
  return {
    appends: [],
    opened: 0,
    discarded: 0,
    released: 0,
    open() {
      this.opened += 1
    },
    appendBase64(base64: string) {
      this.appends.push(base64)
    },
    release() {
      this.released += 1
    },
    discard() {
      this.discarded += 1
    }
  }
}

describe('mediaHandoffMimeFor', () => {
  it('maps the documents and media the OS opens, and nothing else', () => {
    expect(mediaHandoffMimeFor('docs/report.pdf')).toBe('application/pdf')
    expect(mediaHandoffMimeFor('videos/clip.MP4')).toBe('video/mp4')
    expect(mediaHandoffMimeFor('audio/track.m4a')).toBe('audio/mp4')
    expect(mediaHandoffMimeFor('build/orca.zip')).toBeNull()
    expect(mediaHandoffMimeFor('README.md')).toBeNull()
    expect(mediaHandoffMimeFor('README')).toBeNull()
    expect(mediaHandoffMimeFor('.pdf')).toBeNull()
  })
})

describe('downloadMobileFileMedia', () => {
  it('downloads in host-capped chunks until eof and appends each one', async () => {
    const firstChunk = Buffer.alloc(MEDIA_HANDOFF_CHUNK_BYTES, 0xa5).toString('base64')
    const finalChunk = Buffer.alloc(16, 0x5a).toString('base64')
    const client = clientWithResponses([
      ok({ contentBase64: firstChunk, bytesRead: MEDIA_HANDOFF_CHUNK_BYTES, eof: false }),
      ok({ contentBase64: finalChunk, bytesRead: 16, eof: true })
    ])
    const sink = recordingSink()
    const progress: number[] = []

    await expect(
      downloadMobileFileMedia(
        client,
        { worktreeId: 'wt-1', relativePath: 'docs/report.pdf' },
        sink,
        (byteLength) => progress.push(byteLength)
      )
    ).resolves.toEqual({ byteLength: MEDIA_HANDOFF_CHUNK_BYTES + 16 })

    expect(client.sendRequest).toHaveBeenCalledWith(
      'files.readChunk',
      {
        worktree: 'id:wt-1',
        relativePath: 'docs/report.pdf',
        offset: 0,
        length: MEDIA_HANDOFF_CHUNK_BYTES
      },
      { failWhenDisconnected: true, timeoutMs: 30_000 }
    )
    expect(client.sendRequest).toHaveBeenLastCalledWith(
      'files.readChunk',
      {
        worktree: 'id:wt-1',
        relativePath: 'docs/report.pdf',
        offset: MEDIA_HANDOFF_CHUNK_BYTES,
        length: MEDIA_HANDOFF_CHUNK_BYTES
      },
      { failWhenDisconnected: true, timeoutMs: 30_000 }
    )
    expect(sink.opened).toBe(1)
    expect(sink.appends).toEqual([firstChunk, finalChunk])
    expect(progress).toEqual([MEDIA_HANDOFF_CHUNK_BYTES, MEDIA_HANDOFF_CHUNK_BYTES + 16])
    expect(sink.released).toBe(1)
  })

  it('keeps an empty file byte-exact with a single read', async () => {
    const client = clientWithResponses([ok({ contentBase64: '', bytesRead: 0, eof: true })])
    const sink = recordingSink()

    await expect(
      downloadMobileFileMedia(client, { worktreeId: 'wt-1', relativePath: 'e.pdf' }, sink)
    ).resolves.toEqual({ byteLength: 0 })
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
    expect(sink.appends).toEqual([])
  })

  it('surfaces a refused read and discards the partial download', async () => {
    const firstChunk = Buffer.alloc(MEDIA_HANDOFF_CHUNK_BYTES, 0xa5).toString('base64')
    const client = clientWithResponses([
      ok({ contentBase64: firstChunk, bytesRead: MEDIA_HANDOFF_CHUNK_BYTES, eof: false }),
      fail('File is binary', 'binary_file')
    ])
    const sink = recordingSink()

    await expect(
      downloadMobileFileMedia(client, { worktreeId: 'wt-1', relativePath: 'a.pdf' }, sink)
    ).rejects.toThrow('File is binary')
    expect(sink.discarded).toBe(1)
    expect(sink.appends).toEqual([firstChunk])
  })

  it('falls back to the refusal code when the host sends no message', async () => {
    const client = clientWithResponses([fail('', 'forbidden')])

    await expect(
      downloadMobileFileMedia(
        client,
        { worktreeId: 'wt-1', relativePath: 'a.pdf' },
        recordingSink()
      )
    ).rejects.toThrow('forbidden')
  })

  it('rejects a payload whose decoded bytes disagree with bytesRead before appending it', async () => {
    const chunk = 'A'.repeat(4 * 1024 * 1024)
    const chunkBytes = mediaHandoffBase64ByteLength(chunk)
    let appendedBytes = 0
    const sink: MobileFileMediaSink = {
      open() {},
      appendBase64(base64) {
        appendedBytes += mediaHandoffBase64ByteLength(base64)
      },
      release() {},
      discard() {}
    }
    const client = clientWithResponses(
      Array.from({ length: 60 }, () => ok({ contentBase64: chunk, bytesRead: 1, eof: false }))
    )

    await expect(
      downloadMobileFileMedia(client, { worktreeId: 'wt-1', relativePath: 'big.mp4' }, sink)
    ).rejects.toThrow('File changed during download')

    expect(chunkBytes).toBe(3 * 1024 * 1024)
    expect(appendedBytes).toBe(0)
  })

  it('rejects a zero-byte non-EOF chunk and discards the partial download', async () => {
    const sink = recordingSink()
    await expect(
      downloadMobileFileMedia(
        clientWithResponses([ok({ contentBase64: '', bytesRead: 0, eof: false })]),
        { worktreeId: 'wt-1', relativePath: 'stalled.mp4' },
        sink
      )
    ).rejects.toThrow('File changed during download')
    expect(sink.appends).toEqual([])
    expect(sink.discarded).toBe(1)
  })

  it('stops an unmounted attempt before appending the next reply', async () => {
    let release!: (response: RpcResponse) => void
    const client = {
      sendRequest: vi.fn(
        () =>
          new Promise<RpcResponse>((resolve) => {
            release = resolve
          })
      )
    }
    const sink = recordingSink()
    const attempt = createMobileFileMediaAttempt()
    const download = downloadMobileFileMedia(
      client,
      { worktreeId: 'wt-1', relativePath: 'a.mp4' },
      sink,
      undefined,
      attempt
    )
    attempt.cancel()
    release(ok({ contentBase64: 'AAA=', bytesRead: 3, eof: true }))
    await expect(download).rejects.toThrow('cancelled')
    expect(sink.appends).toEqual([])
    expect(sink.discarded).toBe(1)
  })
})
