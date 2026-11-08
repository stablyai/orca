import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { SkillCloudDownloadGrant } from '../../../shared/skill-cloud-contract'
import {
  computeSkillBundleDigest,
  parseSkillBundleManifest
} from '../../../shared/skill-bundle-manifest'
import {
  computeSkillPackageDigest,
  parseSkillPackageManifest
} from '../../../shared/skill-package-manifest'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'

const mocks = vi.hoisted(() => ({
  getRuntimeEnvironmentStatus: vi.fn(),
  installSkillBundleOnRemoteRuntime: vi.fn(),
  installSkillOnRemoteRuntime: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/state', isPackaged: true }
}))
vi.mock('../../ipc/runtime-environments/runtime-environment-status-probe', () => ({
  getRuntimeEnvironmentStatus: mocks.getRuntimeEnvironmentStatus
}))
vi.mock('../runtime-transfer/skill-remote-installation', () => ({
  installSkillBundleOnRemoteRuntime: mocks.installSkillBundleOnRemoteRuntime,
  installSkillOnRemoteRuntime: mocks.installSkillOnRemoteRuntime
}))

import { installSkillBundleCloudGrant } from './skill-cloud-grant-installation'

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
