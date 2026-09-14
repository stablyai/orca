import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callRuntimeEnvironment: vi.fn(),
  downloadSkillPackageGrant: vi.fn()
}))

vi.mock('../ipc/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.callRuntimeEnvironment
}))
vi.mock('./skill-package-download', () => ({
  downloadSkillPackageGrant: mocks.downloadSkillPackageGrant
}))

import { transferSkillPackageToRuntime } from './skill-client-mediated-transfer'

describe('transferSkillPackageToRuntime cancellation', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-skill-transfer-cancel-test-'))
    mocks.callRuntimeEnvironment.mockReset()
    mocks.downloadSkillPackageGrant.mockReset()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('cancels a committed chunk session when the commit request is interrupted', async () => {
    const bytes = Buffer.from('package-data')
    const archivePath = join(root, 'package.tar.gz')
    await writeFile(archivePath, bytes)
    const downloadCleanup = vi.fn(async () => undefined)
    const controller = new AbortController()
    let commitStarted: () => void = () => {}
    const commitPending = new Promise<void>((resolve) => {
      commitStarted = resolve
    })
    mocks.downloadSkillPackageGrant.mockResolvedValue({ archivePath, cleanup: downloadCleanup })
    mocks.callRuntimeEnvironment.mockImplementation((...args: unknown[]) => {
      const method = args[2]
      if (method === 'skills.beginUpload') {
        return Promise.resolve({
          id: 'rpc-begin',
          ok: true,
          result: { uploadId: 'upload-1', chunkBytes: 256 * 1024 },
          _meta: { runtimeId: 'runtime-1' }
        })
      }
      if (method === 'skills.uploadChunk') {
        return Promise.resolve({
          id: 'rpc-chunk',
          ok: true,
          result: { acknowledgedOffset: bytes.length },
          _meta: { runtimeId: 'runtime-1' }
        })
      }
      if (method === 'skills.commitUpload') {
        const options = args[7] as { signal?: AbortSignal }
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true
          })
          commitStarted()
        })
      }
      return Promise.resolve({
        id: 'rpc-cancel',
        ok: true,
        result: undefined,
        _meta: { runtimeId: 'runtime-1' }
      })
    })

    const pending = transferSkillPackageToRuntime({
      userDataPath: root,
      environmentId: 'environment-1',
      transferId: 'operation-1',
      package: {
        packageId: 'package-1',
        versionId: 'version-1',
        packageDigest: 'a'.repeat(64),
        archiveSha256: 'b'.repeat(64),
        compressedBytes: bytes.length
      },
      grant: {
        url: 'https://storage.googleapis.com/bucket/package.tar.gz',
        expiresAt: '2099-01-01T00:00:00.000Z'
      },
      requireHttps: true,
      signal: controller.signal
    })
    await commitPending

    controller.abort()
    await expect(pending).rejects.toThrow('skill-install-cancelled')
    expect(downloadCleanup).toHaveBeenCalledOnce()
    expect(
      mocks.callRuntimeEnvironment.mock.calls.filter((call) => call[2] === 'skills.commitUpload')
    ).toHaveLength(1)
    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      root,
      'environment-1',
      'skills.cancelUpload',
      { uploadId: 'upload-1' },
      15_000
    )
  })
})
