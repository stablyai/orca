import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillCloudDownloadGrant } from '../../shared/skill-cloud-contract'
import {
  computeSkillBundleDigest,
  parseSkillBundleManifest
} from '../../shared/skill-bundle-manifest'
import {
  computeSkillPackageDigest,
  parseSkillPackageManifest
} from '../../shared/skill-package-manifest'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

const mocks = vi.hoisted(() => ({
  getRuntimeEnvironmentStatus: vi.fn(),
  installSkillBundleOnRemoteRuntime: vi.fn(),
  installSkillOnRemoteRuntime: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/state', isPackaged: true }
}))
vi.mock('../ipc/runtime-environments/runtime-environment-status-probe', () => ({
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

const markdown = '# Private skill'
const fileDigest = createHash('sha256').update(markdown).digest('hex')
const files = [
  {
    path: 'SKILL.md',
    size: Buffer.byteLength(markdown),
    executable: false,
    classification: 'text' as const,
    sha256: fileDigest,
    identitySha256: fileDigest
  }
]
const packageDigest = computeSkillPackageDigest(files)
const grant: SkillCloudDownloadGrant = {
  grant: {
    url: 'https://storage.googleapis.com/bucket/package.tar.gz',
    expiresAt: '2099-01-01T00:00:00.000Z'
  },
  version: {
    packageId: 'package-1',
    versionId: 'version-1',
    name: 'private-skill',
    description: '',
    releaseNotes: '',
    createdAt: '2026-08-11T00:00:00.000Z',
    packageDigest,
    archiveSha256: 'b'.repeat(64),
    compressedBytes: 12,
    manifest: parseSkillPackageManifest({
      schemaVersion: 1,
      packageId: 'package-1',
      versionId: 'version-1',
      name: 'private-skill',
      description: '',
      createdAt: '2026-08-11T00:00:00.000Z',
      packageDigest,
      files
    })
  }
}

function bundleDownloadGrant(ids: string[]): SkillCloudDownloadGrant {
  const skills = ids.map((id, index) => ({
    id,
    name: `skill-${String(index).padStart(3, '0')}`,
    description: '',
    digest: packageDigest,
    files
  }))
  const manifest = parseSkillBundleManifest({
    schemaVersion: 1,
    packageId: 'package-1',
    versionId: 'version-1',
    bundleName: 'private-bundle',
    description: '',
    createdAt: '2026-08-11T00:00:00.000Z',
    bundleDigest: computeSkillBundleDigest(skills),
    skills
  })
  return {
    ...grant,
    version: {
      ...grant.version,
      name: 'private-bundle',
      packageDigest: manifest.bundleDigest,
      manifest
    }
  }
}

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
      packageDigest,
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
    const bundleGrant = bundleDownloadGrant(['skill-1'])
    const result = {
      operationId: 'operation-1',
      packageId: 'package-1',
      versionId: 'version-1',
      bundleDigest: bundleGrant.version.packageDigest,
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

it('reports only selected skills in manifest order', async () => {
  const bundleGrant = bundleDownloadGrant(['b', 'a', 'unselected'])
  const runtime = {
    installSharedSkillBundleRequest: vi
      .fn()
      .mockRejectedValue(new Error('skill-install-filesystem-failed'))
  } as unknown as OrcaRuntimeService
  const result = await installSkillBundleCloudGrant(runtime, bundleGrant, {
    operationId: 'op',
    selectedSkillIds: ['a', 'b'],
    destination: { scope: 'global' }
  })
  expect(result.status).toBe('ok')
  if (result.status === 'ok') {
    expect(result.value.skills.map((skill) => skill.skillId)).toEqual(['b', 'a'])
    expect(result.value.status).toBe('failed')
  }
})

it.each(['skill-install-cancelled', 'skill-install-filesystem-failed'])(
  'indexes selected IDs when reporting %s',
  async (code) => {
    let reads = 0
    const ids = Array.from({ length: 512 }, (_, index) => `skill-${index}`)
    const selectedSkillIds = new Proxy(ids, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          reads += 1
        }
        // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: only Reflect.get forwards a raw string|symbol key with the proxy receiver.
        return Reflect.get(target, key, receiver)
      }
    })
    const bundleGrant = bundleDownloadGrant(ids)
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
    expect(reads).toBeLessThanOrEqual(2 * ids.length)
  }
)
