import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillCloudDownloadGrant } from '../../shared/skill-cloud-contract'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

const mocks = vi.hoisted(() => ({
  getRuntimeEnvironmentStatus: vi.fn(),
  installSkillBundleOnRemoteRuntime: vi.fn(),
  installSkillOnRemoteRuntime: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/state', isPackaged: true }
}))
vi.mock('../ipc/runtime-environment-transport-routing', () => ({
  getRuntimeEnvironmentStatus: mocks.getRuntimeEnvironmentStatus
}))
vi.mock('./skill-remote-install-service', () => ({
  installSkillBundleOnRemoteRuntime: mocks.installSkillBundleOnRemoteRuntime,
  installSkillOnRemoteRuntime: mocks.installSkillOnRemoteRuntime
}))

import {
  installSkillBundleCloudGrant,
  installSkillCloudGrant
} from './skill-cloud-grant-installation'

const grant = {
  grant: {
    url: 'https://storage.googleapis.com/bucket/package.tar.gz',
    expiresAt: '2099-01-01T00:00:00.000Z'
  },
  version: {
    packageId: 'package-1',
    versionId: 'version-1',
    name: 'private-skill',
    packageDigest: 'a'.repeat(64),
    archiveSha256: 'b'.repeat(64),
    compressedBytes: 12
  }
} as unknown as SkillCloudDownloadGrant

describe('installSkillCloudGrant', () => {
  beforeEach(() => {
    mocks.getRuntimeEnvironmentStatus.mockReset()
    mocks.installSkillBundleOnRemoteRuntime.mockReset()
    mocks.installSkillOnRemoteRuntime.mockReset()
  })

  it('carries cancellation into client-mediated remote installation', async () => {
    const signal = new AbortController().signal
    const result = {
      operationId: 'operation-1',
      status: 'installed',
      name: 'private-skill',
      packageDigest: 'a'.repeat(64),
      placements: []
    }
    mocks.getRuntimeEnvironmentStatus.mockResolvedValue({
      ok: true,
      result: { capabilities: ['skills.install.v1', 'skills.upload.v1'] }
    })
    mocks.installSkillOnRemoteRuntime.mockResolvedValue(result)

    await expect(
      installSkillCloudGrant(
        {} as OrcaRuntimeService,
        grant,
        {
          operationId: 'operation-1',
          environmentId: 'environment-1',
          destination: { scope: 'global' }
        },
        signal
      )
    ).resolves.toEqual({ status: 'ok', value: result })
    expect(mocks.installSkillOnRemoteRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ signal })
    )
  })

  it('installs selected bundle skills through a capable remote runtime', async () => {
    const bundleGrant = {
      ...grant,
      version: {
        ...grant.version,
        name: 'private-bundle',
        manifest: {
          schemaVersion: 1,
          packageId: 'package-1',
          versionId: 'version-1',
          bundleName: 'private-bundle',
          description: '',
          createdAt: '2026-08-11T00:00:00.000Z',
          bundleDigest: 'c'.repeat(64),
          skills: [
            {
              id: 'skill-1',
              name: 'private-skill',
              description: '',
              digest: 'a'.repeat(64),
              files: []
            }
          ]
        }
      }
    } as unknown as SkillCloudDownloadGrant
    const result = {
      operationId: 'operation-1',
      packageId: 'package-1',
      versionId: 'version-1',
      bundleDigest: 'c'.repeat(64),
      status: 'complete',
      skills: []
    }
    mocks.getRuntimeEnvironmentStatus.mockResolvedValue({
      ok: true,
      result: { capabilities: ['skills.install.bundle.v1', 'skills.upload.v1'] }
    })
    mocks.installSkillBundleOnRemoteRuntime.mockResolvedValue(result)

    await expect(
      installSkillBundleCloudGrant({} as OrcaRuntimeService, bundleGrant, {
        operationId: 'operation-1',
        environmentId: 'environment-1',
        selectedSkillIds: ['skill-1'],
        destination: { scope: 'global' }
      })
    ).resolves.toEqual({ status: 'ok', value: result })
    expect(mocks.installSkillBundleOnRemoteRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ selectedSkillIds: ['skill-1'] })
      })
    )
  })
})

// The failure report is keyed by user-visible skill IDs, so switching the
// membership test from `includes` to a Set must not change which entries appear,
// how often, or in what order.
it('reports selected manifest entries in manifest order, duplicates and all', async () => {
  const skills = ['b', 'a', 'dupe', 'dupe', 'unselected'].map((id) => ({
    id,
    name: `name-${id}`,
    digest: 'a'.repeat(64),
    files: []
  }))
  const bundleGrant = {
    ...grant,
    version: { ...grant.version, manifest: { skills, bundleDigest: 'c'.repeat(64) } }
  } as unknown as SkillCloudDownloadGrant
  const runtime = {
    installSharedSkillBundleRequest: vi
      .fn()
      .mockRejectedValue(new Error('skill-install-filesystem-failed'))
  } as unknown as OrcaRuntimeService
  const result = await installSkillBundleCloudGrant(runtime, bundleGrant, {
    operationId: 'op',
    // Repeated and unknown selections must be inert, exactly as with `includes`.
    selectedSkillIds: ['dupe', 'a', 'a', 'b', 'never-in-manifest'],
    destination: { scope: 'global' }
  })
  expect(result.status).toBe('ok')
  if (result.status === 'ok') {
    expect(result.value.skills.map((skill) => skill.skillId)).toEqual(['b', 'a', 'dupe', 'dupe'])
  }
})

it('reports no skills when nothing was selected', async () => {
  const skills = [{ id: 'a', name: 'a', digest: 'a'.repeat(64), files: [] }]
  const bundleGrant = {
    ...grant,
    version: { ...grant.version, manifest: { skills, bundleDigest: 'c'.repeat(64) } }
  } as unknown as SkillCloudDownloadGrant
  const runtime = {
    installSharedSkillBundleRequest: vi.fn().mockRejectedValue(new Error('skill-install-cancelled'))
  } as unknown as OrcaRuntimeService
  const result = await installSkillBundleCloudGrant(runtime, bundleGrant, {
    operationId: 'op',
    selectedSkillIds: [],
    destination: { scope: 'global' }
  })
  expect(result.status).toBe('ok')
  if (result.status === 'ok') {
    expect(result.value.skills).toEqual([])
  }
})

it.each(['skill-install-cancelled', 'skill-install-filesystem-failed'])(
  'indexes selected IDs when reporting %s',
  async (code) => {
    let reads = 0
    const ids = Array.from({ length: 1000 }, (_, index) => `skill-${index}`)
    const selectedSkillIds = new Proxy(ids, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          reads += 1
        }
        return Reflect.get(target, key, receiver)
      }
    })
    const skills = ids.map((id) => ({ id, name: id, digest: 'a'.repeat(64), files: [] }))
    const bundleGrant = {
      ...grant,
      version: { ...grant.version, manifest: { skills, bundleDigest: 'c'.repeat(64) } }
    } as unknown as SkillCloudDownloadGrant
    const runtime = {
      installSharedSkillBundleRequest: vi.fn().mockRejectedValue(new Error(code))
    } as unknown as OrcaRuntimeService
    const result = await installSkillBundleCloudGrant(runtime, bundleGrant, {
      operationId: 'op',
      selectedSkillIds,
      destination: { scope: 'global' }
    })
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.value.skills.map((skill) => skill.skillId)).toEqual(ids)
      expect(result.value.status).toBe(code.includes('cancelled') ? 'cancelled' : 'failed')
    }
    expect(reads).toBeLessThanOrEqual(2000)
  }
)
