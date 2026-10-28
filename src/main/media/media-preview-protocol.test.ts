import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { RemoteFilePreviewAddress } from '../../shared/remote-file-preview-address'

const { authorize } = vi.hoisted(() => ({
  authorize: vi.fn(async (filePath: string) => filePath)
}))
vi.mock('electron', () => ({
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() }
}))
vi.mock('../ipc/local-file-access-resolution', () => ({
  resolveLocalFileRequestPath: authorize
}))

vi.mock('../ipc/runtime-environments/runtime-environment-registry-root', () => ({
  readRegisteredPairingRevision: vi.fn(() => 9)
}))
vi.mock('./remote-file-preview-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteFilePreviewReader>()),
  statRemotePreviewFile: vi.fn(),
  readRemotePreviewChunk: vi.fn(),
  assertRemoteChunkReadsSupported: vi.fn()
}))

import {
  grantRemoteFilePreview,
  handleMediaPreviewRequest,
  readMediaPreview,
  revokeRemoteFilePreviewGrants
} from './media-preview-protocol'
import {
  RemotePreviewPairingChangedError,
  assertRemoteChunkReadsSupported,
  readRemotePreviewChunk,
  statRemotePreviewFile
} from './remote-file-preview-reader'
import type * as RemoteFilePreviewReader from './remote-file-preview-reader'

describe('media preview protocol', () => {
  let directory: string
  const emitter = new EventEmitter()
  const event = {
    sender: {
      id: 24859,
      on: vi.fn().mockImplementation((name, callback) => emitter.on(name, callback)),
      removeListener: vi
        .fn()
        .mockImplementation((name, callback) => emitter.removeListener(name, callback))
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked authorization resolver never reads Store members.
  const store = {} as Store

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-video-protocol-'))
    authorize.mockReset().mockImplementation(async (path) => path)
  })
  afterEach(async () => {
    emitter.emit('destroyed')
    await rm(directory, { recursive: true, force: true })
  })

  it.each(['mp4', 'MOV', 'm4v', 'webm', 'MP3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus'])(
    'streams %s without returning bytes through IPC',
    async (extension) => {
      const filePath = join(directory, `clip.${extension}`)
      await writeFile(filePath, Uint8Array.from([0, 1, 2, 3, 4, 5]))
      const target = { filePath, access: { kind: 'user-file' } as const }
      const result = readMediaPreview(event, target, store)
      expect(result).toMatchObject({ content: '', isBinary: true })
      expect(result?.mediaUrl).not.toContain(filePath)
      if (!result) {
        throw new Error('Missing preview')
      }
      const response = await handleMediaPreviewRequest(
        new Request(result.mediaUrl, { headers: { range: 'bytes=2-4' } })
      )
      expect(response.status).toBe(206)
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([2, 3, 4])
      expect(authorize).toHaveBeenCalledWith(filePath, target.access, store)
    }
  )

  it('rechecks authorization for every seek and revokes URLs with the renderer', async () => {
    const filePath = join(directory, 'clip.mp4')
    await writeFile(filePath, 'video')
    const result = readMediaPreview(event, { filePath }, store)
    if (!result) {
      throw new Error('Missing preview')
    }
    authorize.mockRejectedValueOnce(new Error('Access denied'))
    expect((await handleMediaPreviewRequest(new Request(result.mediaUrl))).status).toBe(404)
    emitter.emit('destroyed')
    expect((await handleMediaPreviewRequest(new Request(result.mediaUrl))).status).toBe(404)
    expect(authorize).toHaveBeenCalledTimes(1)
  })

  it('rejects directories, forged URLs and non-media paths', async () => {
    const result = readMediaPreview(event, { filePath: join(directory, 'folder.mp4') }, store)
    if (!result) {
      throw new Error('Missing preview')
    }
    authorize.mockResolvedValueOnce(directory)
    expect((await handleMediaPreviewRequest(new Request(result.mediaUrl))).status).toBe(404)
    expect((await handleMediaPreviewRequest(new Request('orca-media://file/unknown'))).status).toBe(
      404
    )
    expect(readMediaPreview(event, { filePath: join(directory, 'secret.txt') }, store)).toBeNull()
  })

  it('does not try a local read for an SSH host', async () => {
    const result = readMediaPreview(
      event,
      { filePath: '/remote/clip.mp4', connectionId: 'ssh-owner' },
      store
    )
    if (!result) {
      throw new Error('Missing preview')
    }
    expect((await handleMediaPreviewRequest(new Request(result.mediaUrl))).status).toBe(404)
    expect(authorize).not.toHaveBeenCalled()
  })

  describe('remote targets', () => {
    const addr = (relativePath: string): RemoteFilePreviewAddress => ({
      environmentId: 'env-1',
      worktree: 'id:wt-1',
      relativePath,
      expectedEnvironmentPairingRevision: 3
    })
    const mint = async (relativePath = 'out/clip.webm'): Promise<string> => {
      const result = await grantRemoteFilePreview(event, addr(relativePath), store)
      if (!result) {
        throw new Error('Missing preview')
      }
      return result.mediaUrl
    }
    const range = (url: string, header = 'bytes=2-4') =>
      handleMediaPreviewRequest(new Request(url, { headers: { range: header } }))
    let now = 1_000_000
    beforeEach(() => {
      vi.spyOn(Date, 'now').mockImplementation(() => now)
      vi.mocked(statRemotePreviewFile).mockReset().mockResolvedValue({ size: 6, mtime: 1 })
      vi.mocked(readRemotePreviewChunk)
        .mockReset()
        .mockResolvedValue(Uint8Array.from([2, 3, 4]))
      vi.mocked(assertRemoteChunkReadsSupported).mockReset().mockResolvedValue(undefined)
    })
    afterEach(() => vi.mocked(Date.now).mockRestore())

    it('mints a stream for audio and video only, after one stat proves the file', async () => {
      const result = await grantRemoteFilePreview(event, addr('out/clip.webm'), store)
      expect(result).toMatchObject({ isBinary: true, mimeType: 'video/webm', content: '' })
      expect(result?.mediaUrl).toMatch(/^orca-media:\/\/file\/[^/?]+\?revision=/)
      expect(statRemotePreviewFile).toHaveBeenCalledTimes(1)
      await expect(grantRemoteFilePreview(event, addr('notes.txt'), store)).resolves.toBeNull()
      expect(statRemotePreviewFile).toHaveBeenCalledTimes(1)
    })

    it('pins a grant the renderer sent unpinned to the pairing it was minted on', async () => {
      const { expectedEnvironmentPairingRevision: _revision, ...unpinned } = addr('out/clip.mp4')
      const result = await grantRemoteFilePreview(event, unpinned, store)
      if (!result) {
        throw new Error('Missing preview')
      }
      await (await range(result.mediaUrl)).arrayBuffer()
      const pinned = { ...unpinned, expectedEnvironmentPairingRevision: 9 }
      expect(statRemotePreviewFile).toHaveBeenCalledWith(pinned, expect.any(AbortSignal))
      expect(readRemotePreviewChunk).toHaveBeenCalledWith(pinned, 2, 3, expect.any(AbortSignal))
    })

    it('fails the mint, not the player, when the host cannot serve chunk reads', async () => {
      vi.mocked(assertRemoteChunkReadsSupported).mockRejectedValue(new Error('update Orca'))
      await expect(grantRemoteFilePreview(event, addr('out/clip.mp4'), store)).rejects.toThrow(
        'update Orca'
      )
    })

    it('a reload within the reuse window reports the size the reload saw', async () => {
      const url = await mint()
      await (await range(url)).arrayBuffer()
      vi.mocked(statRemotePreviewFile).mockResolvedValue({ size: 100, mtime: 2 })
      const reloaded = await mint()
      const response = await range(reloaded)
      await response.arrayBuffer()
      expect(response.headers.get('Content-Range')).toBe('bytes 2-4/100')
    })

    it('streams a remote range', async () => {
      const response = await range(await mint())
      expect(response.status).toBe(206)
      expect(response.headers.get('Content-Range')).toBe('bytes 2-4/6')
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([2, 3, 4])
      expect(readRemotePreviewChunk).toHaveBeenCalledWith(
        addr('out/clip.webm'),
        2,
        3,
        expect.any(AbortSignal)
      )
    })

    it('cancelling the response body aborts the in-flight remote chunk', async () => {
      let chunkSignal: AbortSignal | undefined
      vi.mocked(readRemotePreviewChunk).mockImplementation((_address, _offset, _length, signal) => {
        chunkSignal = signal
        return new Promise(() => {})
      })
      const response = await range(await mint())
      if (!response.body) {
        throw new Error('Missing body')
      }
      const reader = response.body.getReader()
      void reader.read()
      await vi.waitFor(() => expect(chunkSignal).toBeDefined())
      expect(chunkSignal?.aborted).toBe(false)
      await reader.cancel()
      expect(chunkSignal?.aborted).toBe(true)
    })

    it('answers a burst of ranges without a stat per range, then re-stats so a growing file plays on', async () => {
      const url = await mint()
      vi.mocked(statRemotePreviewFile).mockClear()
      const burst = await Promise.all([range(url), range(url, 'bytes=0-1'), range(url, 'bytes=3-')])
      await Promise.all(burst.map((response) => response.arrayBuffer()))
      // The mint's own stat answers the first burst.
      expect(statRemotePreviewFile).not.toHaveBeenCalled()

      vi.mocked(statRemotePreviewFile).mockResolvedValue({ size: 10, mtime: 2 })
      now += 1_500
      const later = await range(url)
      await later.arrayBuffer()
      expect(later.headers.get('Content-Range')).toBe('bytes 2-4/10')
    })

    it('a failed chunk errors that stream and the grant still serves the next request', async () => {
      vi.mocked(readRemotePreviewChunk).mockRejectedValueOnce(new Error('boom'))
      const url = await mint()
      await expect((await range(url)).arrayBuffer()).rejects.toThrow()
      const next = await range(url)
      expect(next.status).toBe(206)
      expect([...new Uint8Array(await next.arrayBuffer())]).toEqual([2, 3, 4])
    })

    it('answers 502 for a lost host, and 410 then 404 once the pairing changed', async () => {
      const url = await mint()
      now += 1_500
      vi.mocked(statRemotePreviewFile).mockRejectedValueOnce(new Error('offline'))
      expect((await range(url)).status).toBe(502)
      now += 1_500
      vi.mocked(statRemotePreviewFile).mockRejectedValueOnce(
        new RemotePreviewPairingChangedError('re-paired')
      )
      expect((await range(url)).status).toBe(410)
      expect((await range(url)).status).toBe(404)
    })

    it("revokes a removed environment's grants and the renderer's on teardown", async () => {
      const removed = await mint()
      revokeRemoteFilePreviewGrants('env-1')
      expect((await range(removed)).status).toBe(404)
      const fresh = await mint()
      expect(fresh).not.toBe(removed)
      expect((await range(fresh)).status).toBe(206)
      emitter.emit('destroyed')
      expect((await range(fresh)).status).toBe(404)
    })
  })
})
