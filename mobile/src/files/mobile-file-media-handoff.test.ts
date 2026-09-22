import { describe, expect, it, vi } from 'vitest'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'
import {
  downloadMobileFileMedia,
  MEDIA_HANDOFF_CHUNK_BYTES,
  MEDIA_HANDOFF_MAX_BYTES,
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
}

function recordingSink(): RecordingSink {
  return {
    appends: [],
    opened: 0,
    discarded: 0,
    open() {
      this.opened += 1
    },
    appendBase64(base64: string) {
      this.appends.push(base64)
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
    const client = clientWithResponses([
      ok({ contentBase64: 'AAA=', bytesRead: 524288, eof: false }),
      ok({ contentBase64: 'QQ==', bytesRead: 16, eof: true })
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
    ).resolves.toEqual({ byteLength: 524304 })

    expect(client.sendRequest).toHaveBeenCalledWith('files.readChunk', {
      worktree: 'id:wt-1',
      relativePath: 'docs/report.pdf',
      offset: 0,
      length: MEDIA_HANDOFF_CHUNK_BYTES
    })
    expect(client.sendRequest).toHaveBeenLastCalledWith('files.readChunk', {
      worktree: 'id:wt-1',
      relativePath: 'docs/report.pdf',
      offset: 524288,
      length: MEDIA_HANDOFF_CHUNK_BYTES
    })
    expect(sink.opened).toBe(1)
    expect(sink.appends).toEqual(['AAA=', 'QQ=='])
    expect(progress).toEqual([524288, 524304])
  })

  it('keeps an empty file byte-exact with a single read', async () => {
    const client = clientWithResponses([ok({ contentBase64: '', bytesRead: 0, eof: false })])
    const sink = recordingSink()

    await expect(
      downloadMobileFileMedia(client, { worktreeId: 'wt-1', relativePath: 'e.pdf' }, sink)
    ).resolves.toEqual({ byteLength: 0 })
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
    expect(sink.appends).toEqual([])
  })

  it('surfaces a refused read and discards the partial download', async () => {
    const client = clientWithResponses([
      ok({ contentBase64: 'AAA=', bytesRead: 524288, eof: false }),
      fail('File is binary', 'binary_file')
    ])
    const sink = recordingSink()

    await expect(
      downloadMobileFileMedia(client, { worktreeId: 'wt-1', relativePath: 'a.pdf' }, sink)
    ).rejects.toThrow('File is binary')
    expect(sink.discarded).toBe(1)
    expect(sink.appends).toEqual(['AAA='])
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

  it('refuses files past the cap and discards what it already wrote', async () => {
    const client = clientWithResponses([
      ok({ contentBase64: 'AAA=', bytesRead: MEDIA_HANDOFF_MAX_BYTES + 1, eof: false })
    ])
    const sink = recordingSink()

    await expect(
      downloadMobileFileMedia(client, { worktreeId: 'wt-1', relativePath: 'big.mp4' }, sink)
    ).rejects.toThrow('File too large to open on this device')
    expect(sink.discarded).toBe(1)
  })
})
