import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillInstallRequest } from '../../shared/skill-install-contract'

const mocks = vi.hoisted(() => ({
  callRuntimeEnvironment: vi.fn(),
  transferSkillPackageToRuntime: vi.fn()
}))

vi.mock('../ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.callRuntimeEnvironment
}))
vi.mock('./skill-client-mediated-transfer', () => ({
  transferSkillPackageToRuntime: mocks.transferSkillPackageToRuntime
}))

import { installSkillOnRemoteRuntime } from './skill-remote-install-service'

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

describe('installSkillOnRemoteRuntime', () => {
  beforeEach(() => {
    mocks.callRuntimeEnvironment.mockReset()
    mocks.transferSkillPackageToRuntime.mockReset()
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
})
