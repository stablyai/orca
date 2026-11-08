import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SkillSharePreparationService } from './skill-share-preparation'
import { writeSkillInstallReceipt } from '../transaction-state/skill-install-provenance'

const temporaryDirectories: string[] = []

async function nameIsFree() {
  return { status: 'ok' as const, value: null }
}

async function createSource(): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-share-preparation-'))
  temporaryDirectories.push(root)
  const source = join(root, 'source')
  await mkdir(source)
  await writeFile(
    join(source, 'SKILL.md'),
    '---\nname: retry-skill\ndescription: Retry publication\n---\n\n# Retry\n'
  )
  return { root, source }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('SkillSharePreparationService', () => {
  it('finds Windows install receipts through a provider junction', async () => {
    const { root, source } = await createSource()
    await writeFile(join(source, 'run.sh'), 'echo without shebang\n')
    const canonicalSource = await realpath(source)
    const providerSource = join(root, 'provider-source')
    await symlink(
      canonicalSource,
      providerSource,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const stateDirectory = join(root, 'state')
    await writeSkillInstallReceipt(stateDirectory, {
      schemaVersion: 1,
      packageId: 'package_1',
      versionId: 'version_1',
      packageDigest: 'a'.repeat(64),
      archiveSha256: 'b'.repeat(64),
      scope: 'global',
      destinationIdentity: 'global:windows',
      canonicalPath: canonicalSource,
      placements: [],
      installedAt: '2026-08-16T12:00:00.000Z',
      hostIdentity: 'windows',
      fileModes: [
        { path: 'SKILL.md', executable: false },
        { path: 'run.sh', executable: true }
      ]
    })
    const service = new SkillSharePreparationService(
      join(root, 'preparations'),
      { findOwnedPackageId: nameIsFree, publishVersion: vi.fn(), createShare: vi.fn() },
      { installStateDirectory: stateDirectory, platform: 'win32' }
    )

    const prepared = await service.prepare({ sourceDirectory: providerSource })

    expect(prepared.skills?.[0]?.executablePaths).toEqual(['run.sh'])
  })

  it('removes abandoned preparations from a previous process before preparing', async () => {
    const { root, source } = await createSource()
    const preparationRoot = join(root, 'preparations')
    await mkdir(join(preparationRoot, 'abandoned'), { recursive: true })
    await writeFile(join(preparationRoot, 'abandoned', 'package.tar.gz'), 'private bytes')
    const service = new SkillSharePreparationService(preparationRoot, {
      findOwnedPackageId: nameIsFree,
      publishVersion: vi.fn(),
      createShare: vi.fn()
    })

    const result = await service.prepare({ sourceDirectory: source })

    expect(await readdir(preparationRoot)).toEqual([result.preparationId])
  })

  it('enforces the preparation cap while archives are still being created', async () => {
    const { root, source } = await createSource()
    const service = new SkillSharePreparationService(join(root, 'preparations'), {
      findOwnedPackageId: nameIsFree,
      publishVersion: vi.fn(),
      createShare: vi.fn()
    })

    const results = await Promise.allSettled(
      Array.from({ length: 9 }, () => service.prepare({ sourceDirectory: source }))
    )

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(8)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: new Error('skill-share-preparation-limit')
    })
  })
})
