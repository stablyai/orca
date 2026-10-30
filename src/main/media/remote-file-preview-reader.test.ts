import { beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeEnvironment } = vi.hoisted(() => ({ callRuntimeEnvironment: vi.fn() }))
vi.mock('../ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment
}))
vi.mock('../ipc/runtime-environments/runtime-environment-registry-root', () => ({
  getRuntimeEnvironmentRegistryRoot: () => '/user-data'
}))

import {
  REMOTE_PREVIEW_UPDATE_REQUIRED_MESSAGE,
  RemotePreviewPairingChangedError,
  assertRemoteChunkReadsSupported,
  readRemotePreviewRange,
  readRemotePreviewChunk,
  statRemotePreviewFile
} from './remote-file-preview-reader'

const address = {
  environmentId: 'env-1',
  worktree: 'id:wt-1',
  relativePath: 'out/clip.mp4',
  expectedEnvironmentPairingRevision: 7
}
const ok = (result: unknown) => ({ ok: true, result })
const fail = (code: string, message: string) => ({ ok: false, error: { code, message } })

describe('remote file preview reader', () => {
  const signal = new AbortController().signal
  beforeEach(() => callRuntimeEnvironment.mockReset())

  it('stats the file through its pinned pairing', async () => {
    callRuntimeEnvironment.mockResolvedValue(
      ok({ size: 6, isDirectory: false, mtime: 1, ctime: 2 })
    )
    await expect(statRemotePreviewFile(address, signal)).resolves.toEqual({
      size: 6,
      mtime: 1,
      ctime: 2
    })
    expect(callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'files.stat',
      { worktree: 'id:wt-1', relativePath: 'out/clip.mp4' },
      15_000,
      7,
      undefined,
      { signal }
    )
  })

  it('refuses a directory', async () => {
    callRuntimeEnvironment.mockResolvedValue(ok({ size: 0, isDirectory: true, mtime: 1 }))
    await expect(statRemotePreviewFile(address, signal)).rejects.toThrow('directory')
  })

  it('decodes a chunk and refuses one whose length disagrees', async () => {
    callRuntimeEnvironment.mockResolvedValueOnce(
      ok({ contentBase64: 'AAECAw==', bytesRead: 4, eof: false })
    )
    await expect(readRemotePreviewChunk(address, 10, 4, signal)).resolves.toEqual(
      new Uint8Array([0, 1, 2, 3])
    )
    callRuntimeEnvironment.mockResolvedValueOnce(
      ok({ contentBase64: 'AAE=', bytesRead: 4, eof: false })
    )
    await expect(readRemotePreviewChunk(address, 0, 4, signal)).rejects.toThrow('corrupted')
  })

  it('tells the user to update a host without range reads', async () => {
    callRuntimeEnvironment.mockResolvedValue(fail('method_not_found', 'x'))
    await expect(statRemotePreviewFile(address, signal)).rejects.toThrow(
      REMOTE_PREVIEW_UPDATE_REQUIRED_MESSAGE
    )
  })

  it('reports a re-paired environment as a dead pairing, not a transient failure', async () => {
    callRuntimeEnvironment.mockResolvedValue(fail('runtime_environment_changed', 'changed'))
    await expect(readRemotePreviewChunk(address, 0, 1, signal)).rejects.toBeInstanceOf(
      RemotePreviewPairingChangedError
    )
  })

  it('proves chunk reads with one byte once per pairing, and re-proves after a re-pair', async () => {
    callRuntimeEnvironment.mockResolvedValue(
      ok({ contentBase64: 'AA==', bytesRead: 1, eof: false })
    )
    const pinned = { ...address, environmentId: 'env-probe' }
    await assertRemoteChunkReadsSupported(pinned, signal)
    await assertRemoteChunkReadsSupported(pinned, signal)
    expect(callRuntimeEnvironment).toHaveBeenCalledTimes(1)
    expect(callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-probe',
      'files.readChunk',
      expect.objectContaining({ offset: 0, length: 1 }),
      20_000,
      7,
      undefined,
      { signal }
    )
    await assertRemoteChunkReadsSupported(
      { ...pinned, expectedEnvironmentPairingRevision: 8 },
      signal
    )
    expect(callRuntimeEnvironment).toHaveBeenCalledTimes(2)
  })

  it('never caches a verdict no pairing revision pins', async () => {
    callRuntimeEnvironment.mockResolvedValue(
      ok({ contentBase64: 'AA==', bytesRead: 1, eof: false })
    )
    const unpinned = { environmentId: 'env-unpinned', worktree: 'id:wt-1', relativePath: 'a.mp4' }
    await assertRemoteChunkReadsSupported(unpinned, signal)
    await assertRemoteChunkReadsSupported(unpinned, signal)
    expect(callRuntimeEnvironment).toHaveBeenCalledTimes(2)
  })

  it('tells the user to update a host that answers files.stat but not files.readChunk', async () => {
    callRuntimeEnvironment.mockResolvedValue(fail('method_not_found', 'x'))
    await expect(
      assertRemoteChunkReadsSupported({ ...address, environmentId: 'env-old' }, signal)
    ).rejects.toThrow(REMOTE_PREVIEW_UPDATE_REQUIRED_MESSAGE)
  })

  it('reads a range in host-sized chunks, clipped to the file and stopping at EOF', async () => {
    callRuntimeEnvironment
      .mockResolvedValueOnce(
        ok({
          contentBase64: Buffer.alloc(262_144, 1).toString('base64'),
          bytesRead: 262_144,
          eof: false
        })
      )
      .mockResolvedValueOnce(ok({ contentBase64: 'AQID', bytesRead: 3, eof: true }))
    const range = await readRemotePreviewRange(address, 10, 900_000, 262_157, signal)
    expect(range.byteLength).toBe(262_147)
    expect(callRuntimeEnvironment.mock.calls[0]?.[3]).toMatchObject({ offset: 10, length: 262_144 })
    expect(callRuntimeEnvironment.mock.calls[1]?.[3]).toMatchObject({ offset: 262_154, length: 3 })
  })
})
