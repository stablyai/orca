import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  previewSharedSkillBundleInstall,
  previewSharedSkillInstall,
  removeSharedSkillInstall
} from './skill-install-management-service'

describe('skill install management', () => {
  let root = ''
  let homeDirectory = ''
  let stateDirectory = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-skill-management-test-'))
    homeDirectory = join(root, 'home')
    stateDirectory = join(root, 'state')
    await Promise.all([mkdir(homeDirectory), mkdir(stateDirectory)])
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function dependencies() {
    return {
      authority: {
        environmentId: 'runtime-1',
        homeDirectory,
        resolveWorktree: async () => null,
        resolveFolderWorkspace: async () => null
      },
      stateDirectory,
      detectProviders: async () => ['codex', 'claude']
    }
  }

  it('previews a missing global install without mutating the destination', async () => {
    const preview = await previewSharedSkillInstall(
      {
        name: 'example',
        package: {
          packageId: 'package-1',
          versionId: 'version-1',
          packageDigest: 'a'.repeat(64),
          archiveSha256: 'b'.repeat(64),
          compressedBytes: 100
        },
        destination: { scope: 'global' }
      },
      dependencies()
    )

    expect(preview).toMatchObject({
      name: 'example',
      currentState: 'missing',
      destinationIdentity: 'global:runtime-1'
    })
    expect(preview.providers.map((provider) => provider.provider)).toEqual(['codex', 'claude'])
  })

  it('resolves providers once for every skill in a bundle preview', async () => {
    const detectProviders = vi.fn(async () => ['codex', 'claude'])
    const preview = await previewSharedSkillBundleInstall(
      {
        package: {
          packageId: 'package-1',
          versionId: 'version-1',
          bundleDigest: 'c'.repeat(64),
          archiveSha256: 'b'.repeat(64),
          compressedBytes: 100
        },
        selectedSkills: ['alpha', 'beta'].map((name) => ({
          id: name,
          name,
          digest: 'a'.repeat(64)
        })),
        destination: { scope: 'global' }
      },
      { ...dependencies(), detectProviders }
    )

    expect(preview.skills.map((skill) => skill.currentState)).toEqual(['missing', 'missing'])
    expect(detectProviders).toHaveBeenCalledOnce()
  })

  it('refuses to remove an unowned destination', async () => {
    const canonicalPath = join(homeDirectory, '.agents', 'skills', 'example')
    await mkdir(canonicalPath, { recursive: true })

    const result = await removeSharedSkillInstall(
      {
        operationId: 'operation-1',
        name: 'example',
        destination: { scope: 'global' }
      },
      dependencies()
    )

    expect(result).toMatchObject({ status: 'conflict', conflict: { kind: 'unowned' } })
  })
})
