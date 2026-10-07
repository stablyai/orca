import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'

const { authorize, provider } = vi.hoisted(() => ({
  authorize: vi.fn(async (filePath: string) => filePath),
  provider: vi.fn()
}))
vi.mock('electron', () => ({ protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() } }))
vi.mock('../ipc/local-file-access-resolution', () => ({ resolveLocalFileRequestPath: authorize }))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({ requireSshFilesystemProvider: provider }))

import { handleMediaPreviewRequest, readMediaPreview } from './media-preview-protocol'

describe('media preview protocol', () => {
  let directory: string
  const emitter = new EventEmitter()
  const event = {
    sender: {
      id: 24859,
      once: vi.fn().mockImplementation((name, callback) => emitter.once(name, callback)),
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
    provider.mockReset()
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

  it('serves SSH ranges on the execution host without reading a local path', async () => {
    const readFileRange = vi.fn(async () => ({ bytes: Buffer.from([7, 8, 9]), bytesRead: 3 }))
    provider.mockReturnValue({ stat: async () => ({ type: 'file', size: 10 }), readFileRange })
    const result = readMediaPreview(
      event,
      { filePath: '/remote/clip.mp4', connectionId: 'ssh-owner' },
      store
    )
    if (!result) {
      throw new Error('Missing preview')
    }
    const response = await handleMediaPreviewRequest(
      new Request(result.mediaUrl, { headers: { range: 'bytes=7-' } })
    )
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([7, 8, 9])
    expect(readFileRange).toHaveBeenCalledWith('/remote/clip.mp4', 7, 3)
    expect(authorize).not.toHaveBeenCalled()
    expect(provider).toHaveBeenCalledWith('ssh-owner')
  })

  it('does not try a local read when an SSH host is disconnected', async () => {
    provider.mockImplementation(() => {
      throw new Error('SSH disconnected')
    })
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
})
