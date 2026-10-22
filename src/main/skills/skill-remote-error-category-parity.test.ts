import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SkillInstallFailureCategorySchema,
  type SkillInstallFailure
} from '../../shared/skill-install-failure'
import type { SkillInstallRequest } from '../../shared/skill-install-contract'

const mocks = vi.hoisted(() => ({ callRuntimeEnvironment: vi.fn() }))

vi.mock('../ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.callRuntimeEnvironment
}))

import { skillInstallFailureFromError } from './skill-install-operation-error'
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

const failures = SkillInstallFailureCategorySchema.options.map(
  (category, index): SkillInstallFailure => ({
    category,
    code: `skill-contract-${category}`,
    retryable: index % 2 === 0
  })
)

async function capturedFailure(promise: Promise<unknown>): Promise<SkillInstallFailure | null> {
  try {
    await promise
    throw new Error('expected-skill-install-failure')
  } catch (error) {
    return skillInstallFailureFromError(error)
  }
}

describe('remote skill failure category', () => {
  beforeEach(() => {
    mocks.callRuntimeEnvironment.mockReset()
  })

  it.each(failures)('preserves $category from a paired runtime', async (failure) => {
    mocks.callRuntimeEnvironment.mockResolvedValue({
      id: 'rpc-1',
      ok: false,
      error: { code: 'skill_install_failure', message: failure.code, data: failure },
      _meta: { runtimeId: 'runtime-1' }
    })
    const paired = await capturedFailure(
      installSkillOnRemoteRuntime({
        userDataPath: '/state',
        environmentId: 'environment-1',
        request,
        capabilities: ['skills.install.v1'],
        requireHttps: true
      })
    )

    expect(paired).toEqual(failure)
  })
})
