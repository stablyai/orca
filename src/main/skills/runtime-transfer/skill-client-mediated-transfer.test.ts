import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callRuntimeEnvironment: vi.fn(),
  downloadSkillPackageGrant: vi.fn()
}))

vi.mock('../../ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.callRuntimeEnvironment
}))
vi.mock('../package-download/skill-package-download', () => ({
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
