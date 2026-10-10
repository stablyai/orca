import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillInstallRequest, SkillInstallResult } from '../../shared/skill-install-contract'
import type {
  SkillBundleInstallRequest,
  SkillBundleInstallResult
} from '../../shared/skill-bundle-install-contract'

const mocks = vi.hoisted(() => ({
  callRuntimeEnvironment: vi.fn(),
  transferSkillPackageToRuntime: vi.fn()
}))

vi.mock('../ipc/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.callRuntimeEnvironment
}))
vi.mock('./skill-client-mediated-transfer', () => ({
  transferSkillPackageToRuntime: mocks.transferSkillPackageToRuntime
}))

import {
  installSkillBundleOnRemoteRuntime,
  installSkillOnRemoteRuntime
} from './skill-remote-install-service'

const request: SkillInstallRequest = {
  operationId: 'operation-1',
  package: {
    packageId: 'package-1',
    versionId: 'version-1',
    packageDigest: 'a'.repeat(64),
    archiveSha256: 'b'.repeat(64),
    compressedBytes: 12
  },
  ingress: {
    kind: 'download-grant',
    url: 'https://storage.googleapis.com/bucket/package.tar.gz',
    expiresAt: '2099-01-01T00:00:00.000Z'
  },
  destination: { scope: 'global' }
}

const result: SkillInstallResult = {
  operationId: request.operationId,
  status: 'installed',
  name: 'example',
  packageDigest: request.package.packageDigest,
  placements: []
}

const bundleRequest: SkillBundleInstallRequest = {
  operationId: 'bundle-operation-1',
  package: {
    packageId: 'package-1',
    versionId: 'version-1',
    bundleDigest: 'c'.repeat(64),
    archiveSha256: 'b'.repeat(64),
    compressedBytes: 12
  },
  selectedSkillIds: ['skill-1'],
  ingress: request.ingress,
  destination: { scope: 'global' },
  conflictDecisions: []
}

const bundleResult: SkillBundleInstallResult = {
  operationId: bundleRequest.operationId,
  packageId: bundleRequest.package.packageId,
  versionId: bundleRequest.package.versionId,
  bundleDigest: bundleRequest.package.bundleDigest,
  status: 'complete',
  skills: []
}

function success(value: unknown) {
  return { id: 'rpc-1', ok: true, result: value, _meta: { runtimeId: 'runtime-1' } }
}

describe('installSkillOnRemoteRuntime', () => {
  beforeEach(() => {
    mocks.callRuntimeEnvironment.mockReset()
    mocks.transferSkillPackageToRuntime.mockReset()
  })

  it('requires a host update before sending an explicit provider choice', async () => {
    await expect(
      installSkillOnRemoteRuntime({
        userDataPath: '/state',
        environmentId: 'environment-1',
        request: { ...request, providers: ['claude'] },
        capabilities: ['skills.install.v1'],
        requireHttps: true
      })
    ).rejects.toThrow('skill-install-remote-update-required')
    expect(mocks.callRuntimeEnvironment).not.toHaveBeenCalled()
  })

  it('uses direct remote download when the runtime can reach storage', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValue(success(result))

    await expect(
      installSkillOnRemoteRuntime({
        userDataPath: '/state',
        environmentId: 'environment-1',
        request,
        capabilities: ['skills.install.v1', 'skills.upload.v1'],
        requireHttps: true
      })
    ).resolves.toEqual(result)

    expect(mocks.transferSkillPackageToRuntime).not.toHaveBeenCalled()
  })

  it('retries an idempotent direct install after a lost response', async () => {
    mocks.callRuntimeEnvironment
      .mockRejectedValueOnce(
        Object.assign(new Error('Remote Orca runtime connection closed'), {
          code: 'remote_runtime_unavailable'
        })
      )
      .mockResolvedValueOnce(success({ ...result, status: 'unchanged' }))

    await expect(
      installSkillOnRemoteRuntime({
        userDataPath: '/state',
        environmentId: 'environment-1',
        request,
        capabilities: ['skills.install.v1', 'skills.upload.v1'],
        requireHttps: true
      })
    ).resolves.toMatchObject({ status: 'unchanged' })
    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledTimes(2)
  })

  it('settles a hung paired install when cancellation reaches the transport', async () => {
    const controller = new AbortController()
    let started: () => void = () => {}
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    mocks.callRuntimeEnvironment.mockImplementation(
      (...args: unknown[]) =>
        new Promise((_resolve, reject) => {
          const options = args[7] as { signal?: AbortSignal }
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true
          })
          started()
        })
    )
    const pending = installSkillOnRemoteRuntime({
      userDataPath: '/state',
      environmentId: 'environment-1',
      request,
      capabilities: ['skills.install.v1'],
      requireHttps: true,
      signal: controller.signal
    })
    await requestStarted

    controller.abort()
    await expect(pending).rejects.toThrow('skill-install-cancelled')
    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledTimes(1)
  })

  it('falls back to a staged client transfer and always cleans it up', async () => {
    const cleanup = vi.fn(async () => undefined)
    mocks.callRuntimeEnvironment
      .mockResolvedValueOnce({
        id: 'rpc-1',
        ok: false,
        error: { code: 'runtime_error', message: 'skill-download-transport-failed' }
      })
      .mockResolvedValueOnce(success(result))
    mocks.transferSkillPackageToRuntime.mockResolvedValue({ uploadId: 'upload-1', cleanup })

    await expect(
      installSkillOnRemoteRuntime({
        userDataPath: '/state',
        environmentId: 'environment-1',
        request,
        capabilities: ['skills.install.v1', 'skills.upload.v1'],
        requireHttps: true
      })
    ).resolves.toEqual(result)

    expect(mocks.callRuntimeEnvironment.mock.calls[1]?.[3]).toMatchObject({
      ingress: { kind: 'staged-upload', uploadId: 'upload-1' }
    })
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('rebuilds the staged transfer after an install response is lost', async () => {
    const firstCleanup = vi.fn(async () => undefined)
    const secondCleanup = vi.fn(async () => undefined)
    mocks.callRuntimeEnvironment
      .mockResolvedValueOnce({
        id: 'rpc-1',
        ok: false,
        error: { code: 'runtime_error', message: 'skill-download-transport-failed' }
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('Remote Orca runtime connection closed'), {
          code: 'remote_runtime_unavailable'
        })
      )
      .mockResolvedValueOnce(success({ ...result, status: 'unchanged' }))
    mocks.transferSkillPackageToRuntime
      .mockResolvedValueOnce({ uploadId: 'upload-1', cleanup: firstCleanup })
      .mockResolvedValueOnce({ uploadId: 'upload-2', cleanup: secondCleanup })

    await expect(
      installSkillOnRemoteRuntime({
        userDataPath: '/state',
        environmentId: 'environment-1',
        request,
        capabilities: ['skills.install.v1', 'skills.upload.v1'],
        requireHttps: true
      })
    ).resolves.toMatchObject({ status: 'unchanged' })
    expect(mocks.transferSkillPackageToRuntime).toHaveBeenCalledTimes(2)
    expect(firstCleanup).toHaveBeenCalledOnce()
    expect(secondCleanup).toHaveBeenCalledOnce()
  })

  it('does not call upload RPCs when the runtime lacks the upload capability', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValue({
      id: 'rpc-1',
      ok: false,
      error: { code: 'runtime_error', message: 'skill-download-transport-failed' }
    })

    await expect(
      installSkillOnRemoteRuntime({
        userDataPath: '/state',
        environmentId: 'environment-1',
        request,
        capabilities: ['skills.install.v1'],
        requireHttps: true
      })
    ).rejects.toThrow('skill-install-remote-download-unavailable')
    expect(mocks.transferSkillPackageToRuntime).not.toHaveBeenCalled()
  })

  it('cleans the staged upload when remote installation fails', async () => {
    const cleanup = vi.fn(async () => undefined)
    mocks.callRuntimeEnvironment
      .mockResolvedValueOnce({
        id: 'rpc-1',
        ok: false,
        error: { code: 'skill-download-transport-failed', message: 'unavailable' }
      })
      .mockResolvedValueOnce({
        id: 'rpc-2',
        ok: false,
        error: { code: 'runtime_error', message: 'install failed' }
      })
    mocks.transferSkillPackageToRuntime.mockResolvedValue({ uploadId: 'upload-1', cleanup })

    await expect(
      installSkillOnRemoteRuntime({
        userDataPath: '/state',
        environmentId: 'environment-1',
        request,
        capabilities: ['skills.install.v1', 'skills.upload.v1'],
        requireHttps: true
      })
    ).rejects.toThrow('skill-install-remote-failed')
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('uses the client for a configured development origin rejected by the host', async () => {
    const cleanup = vi.fn(async () => undefined)
    mocks.callRuntimeEnvironment
      .mockResolvedValueOnce({
        id: 'rpc-1',
        ok: false,
        error: { code: 'runtime_error', message: 'skill-download-origin-rejected' }
      })
      .mockResolvedValueOnce(success(result))
    mocks.transferSkillPackageToRuntime.mockResolvedValue({ uploadId: 'upload-1', cleanup })

    await expect(
      installSkillOnRemoteRuntime({
        userDataPath: '/state',
        environmentId: 'environment-1',
        request,
        capabilities: ['skills.install.v1', 'skills.upload.v1'],
        requireHttps: false
      })
    ).resolves.toEqual(result)
    expect(mocks.transferSkillPackageToRuntime).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('preserves packaged-host policy rejection without attempting transfer', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValue({
      id: 'rpc-1',
      ok: false,
      error: { code: 'runtime_error', message: 'skill-download-origin-rejected' }
    })

    await expect(
      installSkillOnRemoteRuntime({
        userDataPath: '/state',
        environmentId: 'environment-1',
        request,
        capabilities: ['skills.install.v1', 'skills.upload.v1'],
        requireHttps: true
      })
    ).rejects.toThrow('skill-install-remote-failed')
    expect(mocks.transferSkillPackageToRuntime).not.toHaveBeenCalled()
  })
})

describe('installSkillBundleOnRemoteRuntime', () => {
  beforeEach(() => {
    mocks.callRuntimeEnvironment.mockReset()
    mocks.transferSkillPackageToRuntime.mockReset()
  })

  it('uses the additive bundle RPC for direct remote installation', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValue(success(bundleResult))

    await expect(
      installSkillBundleOnRemoteRuntime({
        userDataPath: '/state',
        environmentId: 'environment-1',
        request: bundleRequest,
        capabilities: ['skills.install.bundle.v1', 'skills.upload.v1'],
        requireHttps: true
      })
    ).resolves.toEqual(bundleResult)
    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/state',
      'environment-1',
      'skills.installBundle',
      bundleRequest,
      5 * 60_000
    )
  })

  it('polls current-skill progress only when the destination advertises it', async () => {
    const onProgress = vi.fn()
    const progress = {
      operationId: bundleRequest.operationId,
      skillId: 'skill-1',
      skillName: 'alpha',
      skillIndex: 1,
      skillCount: 30
    }
    mocks.callRuntimeEnvironment.mockImplementation(async (_state, _environment, method: string) =>
      method === 'skills.getInstallProgress' ? success(progress) : success(bundleResult)
    )

    await installSkillBundleOnRemoteRuntime({
      userDataPath: '/state',
      environmentId: 'environment-1',
      request: bundleRequest,
      capabilities: ['skills.install.bundle.v1', 'skills.install-progress.v1'],
      requireHttps: true,
      onProgress
    })

    expect(onProgress).toHaveBeenCalledWith(progress)
    expect(mocks.callRuntimeEnvironment.mock.calls.map((call) => call[2])).toEqual([
      'skills.getInstallProgress',
      'skills.installBundle'
    ])
  })

  it('falls back to staged upload while preserving the bundle selection', async () => {
    const cleanup = vi.fn(async () => undefined)
    mocks.callRuntimeEnvironment
      .mockResolvedValueOnce({
        id: 'rpc-1',
        ok: false,
        error: { code: 'runtime_error', message: 'skill-download-transport-failed' }
      })
      .mockResolvedValueOnce(success(bundleResult))
    mocks.transferSkillPackageToRuntime.mockResolvedValue({ uploadId: 'upload-1', cleanup })

    await expect(
      installSkillBundleOnRemoteRuntime({
        userDataPath: '/state',
        environmentId: 'environment-1',
        request: bundleRequest,
        capabilities: ['skills.install.bundle.v1', 'skills.upload.v1'],
        requireHttps: true
      })
    ).resolves.toEqual(bundleResult)
    expect(mocks.callRuntimeEnvironment.mock.calls[1]?.[3]).toMatchObject({
      selectedSkillIds: ['skill-1'],
      ingress: { kind: 'staged-upload', uploadId: 'upload-1' }
    })
    expect(cleanup).toHaveBeenCalledOnce()
  })
})
