import { beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeEnvironment } = vi.hoisted(() => ({ callRuntimeEnvironment: vi.fn() }))
vi.mock('../ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment
}))
vi.mock('../ipc/runtime-environments/runtime-environment-registry-root', () => ({
  getRuntimeEnvironmentRegistryRoot: () => '/user-data'
}))

import {
  assertRemoteChunkReadsSupported,
  readRemotePreviewRange,
  readRemotePreviewChunk,
  renewRemotePreviewGrant
} from './remote-file-preview-reader'

const address = {
  environmentId: 'env-1',
  worktree: 'id:wt-1',
  relativePath: 'out/clip.mp4',
  expectedEnvironmentPairingRevision: 7
}
const ok = (result: unknown) => ({ ok: true, result })

describe('remote file preview reader', () => {
  const signal = new AbortController().signal
  beforeEach(() => callRuntimeEnvironment.mockReset())

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

  // Why: a host can answer files.readChunk yet lack the grant's paging method.
  it('pages a granted file through its grant, proven apart from workspace reads', async () => {
    callRuntimeEnvironment.mockResolvedValue(
      ok({ contentBase64: 'AA==', bytesRead: 1, eof: false })
    )
    const workspace = { ...address, environmentId: 'env-kinds' }
    const { relativePath: _relativePath, ...base } = workspace
    const granted = { ...base, grantId: 'g-1', absolutePath: '/tmp/clip.mp4' }
    await assertRemoteChunkReadsSupported(workspace, signal)
    await assertRemoteChunkReadsSupported(granted, signal)
    expect(callRuntimeEnvironment).toHaveBeenLastCalledWith(
      '/user-data',
      'env-kinds',
      'files.readTerminalArtifactChunk',
      { worktree: 'id:wt-1', grantId: 'g-1', absolutePath: '/tmp/clip.mp4', offset: 0, length: 1 },
      20_000,
      7,
      undefined,
      { signal }
    )
    expect(callRuntimeEnvironment).toHaveBeenCalledTimes(2)
  })

  it('renews a granted file only at the path its first grant named', async () => {
    const { relativePath: _relativePath, ...base } = address
    const granted = { ...base, grantId: 'g-1', absolutePath: '/tmp/clip.mp4' }
    const answer = (absolutePath: string) =>
      ok({ openTarget: { kind: 'absolute-file', absolutePath, grantId: 'g-2' } })
    callRuntimeEnvironment.mockResolvedValueOnce(answer('/tmp/clip.mp4'))
    await expect(renewRemotePreviewGrant(granted, signal)).resolves.toEqual({
      ...granted,
      grantId: 'g-2'
    })
    expect(callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'files.resolveTerminalPath',
      { worktree: 'id:wt-1', pathText: '/tmp/clip.mp4' },
      15_000,
      7,
      undefined,
      { signal }
    )
    callRuntimeEnvironment.mockResolvedValueOnce(answer('/tmp/other.mp4'))
    await expect(renewRemotePreviewGrant(granted, signal)).rejects.toThrow('no longer grants')
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
