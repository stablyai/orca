import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

describe('transferSkillPackageToRuntime', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-skill-transfer-test-'))
    mocks.callRuntimeEnvironment.mockReset()
    mocks.downloadSkillPackageGrant.mockReset()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('cleans the local package after bounded begin retries', async () => {
    const archivePath = join(root, 'package.tar.gz')
    await writeFile(archivePath, Buffer.from('package-data'))
    const cleanup = vi.fn(async () => undefined)
    mocks.downloadSkillPackageGrant.mockResolvedValue({ archivePath, cleanup })
    mocks.callRuntimeEnvironment.mockRejectedValue(new Error('connection dropped'))

    await expect(
      transferSkillPackageToRuntime({
        userDataPath: root,
        environmentId: 'environment-1',
        transferId: 'operation-1',
        package: {
          packageId: 'package-1',
          versionId: 'version-1',
          packageDigest: 'a'.repeat(64),
          archiveSha256: 'b'.repeat(64),
          compressedBytes: 12
        },
        grant: {
          url: 'https://storage.googleapis.com/bucket/package.tar.gz',
          expiresAt: '2099-01-01T00:00:00.000Z'
        },
        requireHttps: true
      })
    ).rejects.toThrow('connection dropped')

    expect(cleanup).toHaveBeenCalledOnce()
    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledTimes(3)
  })

  it('reuses the operation identity and resumes an acknowledged upload', async () => {
    const archivePath = join(root, 'package.tar.gz')
    const bytes = Buffer.from('package-data')
    await writeFile(archivePath, bytes)
    const cleanup = vi.fn(async () => undefined)
    mocks.downloadSkillPackageGrant.mockResolvedValue({ archivePath, cleanup })
    const beginRequests: unknown[] = []
    let beginAttempts = 0
    mocks.callRuntimeEnvironment.mockImplementation(
      async (_userData: string, _environment: string, method: string, params: unknown) => {
        if (method === 'skills.beginUpload') {
          beginRequests.push(params)
          beginAttempts += 1
          if (beginAttempts === 1) {
            throw new Error('connection dropped after receiver resumed upload')
          }
          return {
            id: 'rpc-begin',
            ok: true,
            result: { uploadId: 'upload-1', chunkBytes: 256 * 1024, acknowledgedOffset: 4 },
            _meta: { runtimeId: 'runtime-1' }
          }
        }
        if (method === 'skills.uploadChunk') {
          const chunk = params as { offset: number; bytesBase64: string }
          expect(chunk.offset).toBe(4)
          expect(Buffer.from(chunk.bytesBase64, 'base64')).toEqual(bytes.subarray(4))
          return {
            id: 'rpc-chunk',
            ok: true,
            result: { acknowledgedOffset: bytes.length },
            _meta: { runtimeId: 'runtime-1' }
          }
        }
        return {
          id: 'rpc-success',
          ok: true,
          result: { uploadId: 'upload-1' },
          _meta: { runtimeId: 'runtime-1' }
        }
      }
    )

    const transferred = await transferSkillPackageToRuntime({
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
      requireHttps: true
    })
    await transferred.cleanup()

    expect(beginRequests).toEqual([
      expect.objectContaining({ transferId: 'operation-1' }),
      expect.objectContaining({ transferId: 'operation-1' })
    ])
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('rejects an invalid acknowledgement and cancels the remote session', async () => {
    const archivePath = join(root, 'package.tar.gz')
    await writeFile(archivePath, Buffer.from('package-data'))
    const downloadCleanup = vi.fn(async () => undefined)
    mocks.downloadSkillPackageGrant.mockResolvedValue({ archivePath, cleanup: downloadCleanup })
    mocks.callRuntimeEnvironment.mockImplementation(
      async (_userData: string, _environment: string, method: string) => {
        if (method === 'skills.beginUpload') {
          return {
            id: 'rpc-1',
            ok: true,
            result: { uploadId: 'upload-1', chunkBytes: 256 * 1024 },
            _meta: { runtimeId: 'runtime-1' }
          }
        }
        if (method === 'skills.uploadChunk') {
          return {
            id: 'rpc-2',
            ok: true,
            result: { acknowledgedOffset: 1 },
            _meta: { runtimeId: 'runtime-1' }
          }
        }
        return {
          id: 'rpc-3',
          ok: true,
          result: undefined,
          _meta: { runtimeId: 'runtime-1' }
        }
      }
    )

    await expect(
      transferSkillPackageToRuntime({
        userDataPath: root,
        environmentId: 'environment-1',
        transferId: 'operation-1',
        package: {
          packageId: 'package-1',
          versionId: 'version-1',
          packageDigest: 'a'.repeat(64),
          archiveSha256: 'b'.repeat(64),
          compressedBytes: 12
        },
        grant: {
          url: 'https://storage.googleapis.com/bucket/package.tar.gz',
          expiresAt: '2099-01-01T00:00:00.000Z'
        },
        requireHttps: true
      })
    ).rejects.toThrow('skill-transfer-ack-invalid')

    expect(downloadCleanup).toHaveBeenCalledOnce()
    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      root,
      'environment-1',
      'skills.cancelUpload',
      { uploadId: 'upload-1' },
      15_000
    )
  })

  it('cancels the remote upload when commit fails', async () => {
    const archivePath = join(root, 'package.tar.gz')
    await writeFile(archivePath, Buffer.from('package-data'))
    const downloadCleanup = vi.fn(async () => undefined)
    mocks.downloadSkillPackageGrant.mockResolvedValue({ archivePath, cleanup: downloadCleanup })
    mocks.callRuntimeEnvironment.mockImplementation(
      async (_userData: string, _environment: string, method: string) => {
        if (method === 'skills.beginUpload') {
          return {
            id: 'rpc-1',
            ok: true,
            result: { uploadId: 'upload-1', chunkBytes: 256 * 1024 },
            _meta: { runtimeId: 'runtime-1' }
          }
        }
        if (method === 'skills.uploadChunk') {
          return {
            id: 'rpc-2',
            ok: true,
            result: { acknowledgedOffset: 12 },
            _meta: { runtimeId: 'runtime-1' }
          }
        }
        if (method === 'skills.commitUpload') {
          return {
            id: 'rpc-3',
            ok: false,
            error: { code: 'skill-upload-commit-failed', message: 'commit failed' },
            _meta: { runtimeId: 'runtime-1' }
          }
        }
        return {
          id: 'rpc-4',
          ok: true,
          result: undefined,
          _meta: { runtimeId: 'runtime-1' }
        }
      }
    )

    await expect(
      transferSkillPackageToRuntime({
        userDataPath: root,
        environmentId: 'environment-1',
        transferId: 'operation-1',
        package: {
          packageId: 'package-1',
          versionId: 'version-1',
          packageDigest: 'a'.repeat(64),
          archiveSha256: 'b'.repeat(64),
          compressedBytes: 12
        },
        grant: {
          url: 'https://storage.googleapis.com/bucket/package.tar.gz',
          expiresAt: '2099-01-01T00:00:00.000Z'
        },
        requireHttps: true
      })
    ).rejects.toThrow('skill-transfer-remote-skill-upload-commit-failed')

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

  it('cancels the session after bounded chunk retry exhaustion', async () => {
    const archivePath = join(root, 'package.tar.gz')
    await writeFile(archivePath, Buffer.from('package-data'))
    const cleanup = vi.fn(async () => undefined)
    mocks.downloadSkillPackageGrant.mockResolvedValue({ archivePath, cleanup })
    mocks.callRuntimeEnvironment.mockImplementation(
      async (_userData: string, _environment: string, method: string) => {
        if (method === 'skills.beginUpload') {
          return {
            id: 'rpc-begin',
            ok: true,
            result: { uploadId: 'upload-1', chunkBytes: 256 * 1024 },
            _meta: { runtimeId: 'runtime-1' }
          }
        }
        if (method === 'skills.uploadChunk') {
          throw new Error('connection dropped')
        }
        return {
          id: 'rpc-cancel',
          ok: true,
          result: undefined,
          _meta: { runtimeId: 'runtime-1' }
        }
      }
    )

    await expect(
      transferSkillPackageToRuntime({
        userDataPath: root,
        environmentId: 'environment-1',
        transferId: 'operation-1',
        package: {
          packageId: 'package-1',
          versionId: 'version-1',
          packageDigest: 'a'.repeat(64),
          archiveSha256: 'b'.repeat(64),
          compressedBytes: 12
        },
        grant: {
          url: 'https://storage.googleapis.com/bucket/package.tar.gz',
          expiresAt: '2099-01-01T00:00:00.000Z'
        },
        requireHttps: true
      })
    ).rejects.toThrow('connection dropped')

    expect(
      mocks.callRuntimeEnvironment.mock.calls.filter((call) => call[2] === 'skills.uploadChunk')
    ).toHaveLength(3)
    expect(
      mocks.callRuntimeEnvironment.mock.calls.filter((call) => call[2] === 'skills.cancelUpload')
    ).toHaveLength(1)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('retries the identical chunk and idempotent commit after lost responses', async () => {
    const archivePath = join(root, 'package.tar.gz')
    await writeFile(archivePath, Buffer.from('package-data'))
    const cleanup = vi.fn(async () => undefined)
    mocks.downloadSkillPackageGrant.mockResolvedValue({ archivePath, cleanup })
    let chunkAttempts = 0
    let commitAttempts = 0
    mocks.callRuntimeEnvironment.mockImplementation(
      async (_userData: string, _environment: string, method: string, params: unknown) => {
        if (method === 'skills.beginUpload') {
          return {
            id: 'rpc-begin',
            ok: true,
            result: { uploadId: 'upload-1', chunkBytes: 256 * 1024 },
            _meta: { runtimeId: 'runtime-1' }
          }
        }
        if (method === 'skills.uploadChunk') {
          chunkAttempts += 1
          if (chunkAttempts === 1) {
            throw new Error('connection dropped after receiver write')
          }
          return {
            id: 'rpc-chunk',
            ok: true,
            result: { acknowledgedOffset: 12 },
            _meta: { runtimeId: 'runtime-1' }
          }
        }
        if (method === 'skills.commitUpload') {
          commitAttempts += 1
          if (commitAttempts === 1) {
            throw new Error('connection dropped after receiver commit')
          }
          return {
            id: 'rpc-commit',
            ok: true,
            result: { uploadId: 'upload-1' },
            _meta: { runtimeId: 'runtime-1' }
          }
        }
        expect(method).toBe('skills.cancelUpload')
        expect(params).toEqual({ uploadId: 'upload-1' })
        return {
          id: 'rpc-cancel',
          ok: true,
          result: undefined,
          _meta: { runtimeId: 'runtime-1' }
        }
      }
    )

    const transferred = await transferSkillPackageToRuntime({
      userDataPath: root,
      environmentId: 'environment-1',
      transferId: 'operation-1',
      package: {
        packageId: 'package-1',
        versionId: 'version-1',
        packageDigest: 'a'.repeat(64),
        archiveSha256: 'b'.repeat(64),
        compressedBytes: 12
      },
      grant: {
        url: 'https://storage.googleapis.com/bucket/package.tar.gz',
        expiresAt: '2099-01-01T00:00:00.000Z'
      },
      requireHttps: true
    })
    await transferred.cleanup()

    expect(chunkAttempts).toBe(2)
    expect(commitAttempts).toBe(2)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('cancels the begun session when cancellation arrives before chunking', async () => {
    const archivePath = join(root, 'package.tar.gz')
    await writeFile(archivePath, Buffer.from('package-data'))
    const cleanup = vi.fn(async () => undefined)
    const controller = new AbortController()
    mocks.downloadSkillPackageGrant.mockResolvedValue({ archivePath, cleanup })
    mocks.callRuntimeEnvironment.mockImplementation(
      async (_userData: string, _environment: string, method: string) => {
        if (method === 'skills.beginUpload') {
          controller.abort()
          return {
            id: 'rpc-begin',
            ok: true,
            result: { uploadId: 'upload-1', chunkBytes: 256 * 1024 },
            _meta: { runtimeId: 'runtime-1' }
          }
        }
        return {
          id: 'rpc-cancel',
          ok: true,
          result: undefined,
          _meta: { runtimeId: 'runtime-1' }
        }
      }
    )

    await expect(
      transferSkillPackageToRuntime({
        userDataPath: root,
        environmentId: 'environment-1',
        transferId: 'operation-1',
        package: {
          packageId: 'package-1',
          versionId: 'version-1',
          packageDigest: 'a'.repeat(64),
          archiveSha256: 'b'.repeat(64),
          compressedBytes: 12
        },
        grant: {
          url: 'https://storage.googleapis.com/bucket/package.tar.gz',
          expiresAt: '2099-01-01T00:00:00.000Z'
        },
        requireHttps: true,
        signal: controller.signal
      })
    ).rejects.toThrow('skill-install-cancelled')
    expect(cleanup).toHaveBeenCalledOnce()
    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      root,
      'environment-1',
      'skills.cancelUpload',
      { uploadId: 'upload-1' },
      15_000
    )
  })
})
