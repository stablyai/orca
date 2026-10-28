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
  readRemotePreviewRange: vi.fn(),
  assertRemoteChunkReadsSupported: vi.fn()
}))

import {
  MEDIA_PREVIEW_CUSTOM_SCHEME,
  grantRemoteFilePreview,
  handleMediaPreviewRequest,
  readLocalFilePreview,
  revokeRemoteFilePreviewGrants
} from './media-preview-protocol'
import {
  REMOTE_PREVIEW_UPDATE_REQUIRED_MESSAGE,
  RemotePreviewPairingChangedError,
  assertRemoteChunkReadsSupported,
  readRemotePreviewChunk,
  readRemotePreviewRange,
  statRemotePreviewFile
} from './remote-file-preview-reader'
import type * as RemoteFilePreviewReader from './remote-file-preview-reader'

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  bytes.set([8, 6, 0, 0, 0], 24)
  return bytes
}

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
      const result = await readLocalFilePreview(event, target, store, { documents: false })
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
    const result = await readLocalFilePreview(event, { filePath }, store, { documents: false })
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
    const result = await readLocalFilePreview(
      event,
      { filePath: join(directory, 'folder.mp4') },
      store,
      { documents: false }
    )
    if (!result) {
      throw new Error('Missing preview')
    }
    authorize.mockResolvedValueOnce(directory)
    expect((await handleMediaPreviewRequest(new Request(result.mediaUrl))).status).toBe(404)
    expect((await handleMediaPreviewRequest(new Request('orca-media://file/unknown'))).status).toBe(
      404
    )
    expect(
      await readLocalFilePreview(event, { filePath: join(directory, 'secret.txt') }, store, {
        documents: false
      })
    ).toBeNull()
  })

  it('mints an image or PDF URL only for a viewer that asks, with its size', async () => {
    const filePath = join(directory, 'shot.png')
    await writeFile(filePath, png(4, 3))
    await expect(
      readLocalFilePreview(event, { filePath }, store, { documents: false })
    ).resolves.toBeNull()
    const result = await readLocalFilePreview(event, { filePath }, store, { documents: true })
    expect(result).toMatchObject({ isImage: true, mimeType: 'image/png', size: 33 })
    const response = await handleMediaPreviewRequest(new Request(result?.mediaUrl ?? ''))
    // No CORS: no other origin can read these bytes with fetch.
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png(4, 3))
  })

  it('classifies a linked image or PDF by its target, then and on every read', async () => {
    const filePath = join(directory, 'shot.png')
    const drawing = join(directory, 'drawing.svg')
    await writeFile(filePath, png(4, 3))
    await writeFile(drawing, '<svg/>')
    authorize.mockResolvedValueOnce(drawing)
    await expect(
      readLocalFilePreview(event, { filePath }, store, { documents: true })
    ).resolves.toMatchObject({ mimeType: 'image/svg+xml' })
    authorize.mockResolvedValueOnce(join(directory, 'notes.txt'))
    expect(await readLocalFilePreview(event, { filePath }, store, { documents: true })).toBeNull()
    const result = await readLocalFilePreview(event, { filePath }, store, { documents: true })
    authorize.mockResolvedValueOnce(drawing)
    expect((await handleMediaPreviewRequest(new Request(result?.mediaUrl ?? ''))).status).toBe(404)
  })

  it('refuses an image whose header proves it too large to decode safely', async () => {
    const filePath = join(directory, 'bomb.png')
    await writeFile(filePath, png(100_000, 100_000))
    await expect(
      readLocalFilePreview(event, { filePath }, store, { documents: true })
    ).rejects.toThrow('Image dimensions exceed the preview safety limit')
  })

  it('mints nothing for a renderer torn down while the image was being checked', async () => {
    const filePath = join(directory, 'late.png')
    await writeFile(filePath, png(4, 3))
    let release: () => void = () => {}
    authorize.mockImplementationOnce(
      (path) => new Promise((resolve) => (release = () => resolve(path)))
    )
    const pending = readLocalFilePreview(event, { filePath }, store, { documents: true })
    await vi.waitFor(() => expect(authorize).toHaveBeenCalled())
    emitter.emit('destroyed')
    release()
    await expect(pending).rejects.toThrow()
  })

  it('gives another origin no CORS answer, preflight or not', async () => {
    const filePath = join(directory, 'doc.pdf')
    await writeFile(filePath, '%PDF-1.4')
    const result = await readLocalFilePreview(event, { filePath }, store, { documents: true })
    const url = result?.mediaUrl ?? ''
    const fromPage = await handleMediaPreviewRequest(
      new Request(url, { headers: { origin: 'https://example.com' } })
    )
    expect(fromPage.headers.get('Access-Control-Allow-Origin')).toBeNull()
    const preflight = await handleMediaPreviewRequest(new Request(url, { method: 'OPTIONS' }))
    expect(preflight.status).toBe(405)
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('claims only the element-load privileges, never fetch or CORS', () => {
    expect(MEDIA_PREVIEW_CUSTOM_SCHEME.privileges).toEqual({
      standard: true,
      secure: true,
      stream: true
    })
  })

  it('checks the image it serves, not just the one it minted', async () => {
    const filePath = join(directory, 'swapped.png')
    await writeFile(filePath, png(4, 3))
    const result = await readLocalFilePreview(event, { filePath }, store, { documents: true })
    await writeFile(filePath, png(100_000, 100_000))
    expect((await handleMediaPreviewRequest(new Request(result?.mediaUrl ?? ''))).status).toBe(404)
  })

  it('does not try a local read for an SSH host', async () => {
    const result = await readLocalFilePreview(
      event,
      { filePath: '/remote/clip.mp4', connectionId: 'ssh-owner' },
      store,
      { documents: false }
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

    it('streams a remote image or PDF to its viewer, refusing a proven-oversized image', async () => {
      vi.mocked(readRemotePreviewRange).mockImplementation(async (address) =>
        address.relativePath.endsWith('.pdf') ? new TextEncoder().encode('%PDF-1.7') : png(4, 3)
      )
      await expect(
        grantRemoteFilePreview(event, addr('docs/shot.png'), store)
      ).resolves.toMatchObject({
        isImage: true,
        mimeType: 'image/png',
        size: 6
      })
      await expect(
        grantRemoteFilePreview(event, addr('docs/spec.pdf'), store)
      ).resolves.toMatchObject({
        isImage: true,
        mimeType: 'application/pdf'
      })
      vi.mocked(readRemotePreviewRange).mockResolvedValue(png(100_000, 100_000))
      await expect(grantRemoteFilePreview(event, addr('docs/bomb.png'), store)).rejects.toThrow(
        'Image dimensions exceed the preview safety limit'
      )
      vi.mocked(readRemotePreviewRange).mockImplementation(async (address) =>
        address.relativePath.endsWith('.pdf') ? new TextEncoder().encode('%PDF-1.7') : png(4, 3)
      )
      vi.mocked(statRemotePreviewFile).mockResolvedValueOnce({ size: 60 * 1024 * 1024, mtime: 1 })
      // An <img> decodes the whole file, so images keep the 50 MB cap; PDFs read by range don't.
      await expect(grantRemoteFilePreview(event, addr('docs/huge.png'), store)).rejects.toThrow(
        'File too large'
      )
      vi.mocked(statRemotePreviewFile).mockResolvedValueOnce({ size: 60 * 1024 * 1024, mtime: 1 })
      await expect(
        grantRemoteFilePreview(event, addr('docs/huge.pdf'), store)
      ).resolves.toMatchObject({
        size: 60 * 1024 * 1024
      })
    })

    it("leaves an older host's images and PDFs on files.readPreview, and refuses a swapped image", async () => {
      vi.mocked(assertRemoteChunkReadsSupported).mockRejectedValueOnce(
        new Error(REMOTE_PREVIEW_UPDATE_REQUIRED_MESSAGE)
      )
      await expect(grantRemoteFilePreview(event, addr('docs/spec.pdf'), store)).resolves.toBeNull()

      vi.mocked(readRemotePreviewRange).mockResolvedValueOnce(png(4, 3))
      const minted = await grantRemoteFilePreview(event, addr('docs/shot.png'), store)
      vi.mocked(readRemotePreviewRange).mockResolvedValueOnce(png(100_000, 100_000))
      expect((await range(minted?.mediaUrl ?? '')).status).not.toBe(206)
    })

    it('leaves a remote image or PDF whose bytes are another kind to files.readPreview', async () => {
      vi.mocked(readRemotePreviewRange).mockResolvedValue(new TextEncoder().encode('<svg/>'))
      await expect(grantRemoteFilePreview(event, addr('docs/shot.png'), store)).resolves.toBeNull()
      await expect(grantRemoteFilePreview(event, addr('docs/spec.pdf'), store)).resolves.toBeNull()
      await expect(
        grantRemoteFilePreview(event, addr('docs/drawing.svg'), store)
      ).resolves.toMatchObject({ mimeType: 'image/svg+xml' })
      vi.mocked(readRemotePreviewRange).mockResolvedValue(png(4, 3))
      await expect(
        grantRemoteFilePreview(event, addr('docs/drawing.svg'), store)
      ).resolves.toBeNull()
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
