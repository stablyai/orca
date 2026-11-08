import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromises>()),
  symlink: vi.fn(async () => {
    throw new Error('injected-alias-denial')
  })
}))

import { nativeSkillInstallFilesystem } from '../filesystem/skill-install-filesystem'
import type { SkillInstallReceiptV1 } from '../transaction-state/skill-install-provenance'
import { reconcileSkillProviderPlacement } from './skill-placement-reconciliation'

const temporaryDirectories: string[] = []

function receipt(canonicalPath: string, packageDigest: string): SkillInstallReceiptV1 {
  return {
    schemaVersion: 1,
    packageId: 'package_1',
    versionId: 'version_1',
    packageDigest,
    archiveSha256: 'a'.repeat(64),
    scope: 'global',
    destinationIdentity: 'global:test',
    canonicalPath,
    placements: [],
    installedAt: new Date().toISOString(),
    hostIdentity: 'test',
    fileModes: [],
    providers: []
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('skill provider placement reconciliation', () => {
  it('creates a verified independent copy when native alias creation is denied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-placement-test-'))
    temporaryDirectories.push(root)
    const canonicalPath = join(root, 'canonical', 'private-skill')
    const providerRoot = join(root, 'provider')
    await mkdir(canonicalPath, { recursive: true })
    await writeFile(join(canonicalPath, 'SKILL.md'), 'private skill')
    const observed = await nativeSkillInstallFilesystem.observeSkill(canonicalPath)

    const result = await reconcileSkillProviderPlacement({
      canonicalPath,
      skillName: 'private-skill',
      destination: { provider: 'claude', rootPath: providerRoot, readsCanonicalRoot: false },
      previousReceipt: null,
      packageDigest: observed.observedDigest
    })

    expect(result).toMatchObject({ topology: 'independent-copy', status: 'installed' })
    expect(await readFile(join(providerRoot, 'private-skill', 'SKILL.md'), 'utf8')).toBe(
      'private skill'
    )
  })

  it('updates an owned copy even when host alias inspection returns false', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-placement-test-'))
    temporaryDirectories.push(root)
    const canonicalPath = join(root, 'canonical', 'private-skill')
    const providerRoot = join(root, 'provider')
    const destinationPath = join(providerRoot, 'private-skill')
    await mkdir(canonicalPath, { recursive: true })
    await mkdir(destinationPath, { recursive: true })
    await writeFile(join(canonicalPath, 'SKILL.md'), 'new skill')
    await writeFile(join(destinationPath, 'SKILL.md'), 'old skill')
    const previousDigest = (await nativeSkillInstallFilesystem.observeSkill(destinationPath))
      .observedDigest
    const nextDigest = (await nativeSkillInstallFilesystem.observeSkill(canonicalPath))
      .observedDigest
    const previous = receipt(canonicalPath, previousDigest)
    previous.placements = [
      {
        provider: 'claude',
        path: destinationPath,
        topology: 'independent-copy',
        status: 'installed'
      }
    ]

    const result = await reconcileSkillProviderPlacement({
      canonicalPath,
      skillName: 'private-skill',
      destination: { provider: 'claude', rootPath: providerRoot, readsCanonicalRoot: false },
      previousReceipt: previous,
      packageDigest: nextDigest,
      filesystem: { ...nativeSkillInstallFilesystem, aliasTargets: async () => false }
    })

    expect(result).toMatchObject({ topology: 'independent-copy', status: 'installed' })
    expect(await readFile(join(destinationPath, 'SKILL.md'), 'utf8')).toBe('new skill')
  })

  it('does not update a byte-identical copy previously recorded as skipped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-placement-test-'))
    temporaryDirectories.push(root)
    const canonicalPath = join(root, 'canonical', 'private-skill')
    const providerRoot = join(root, 'provider')
    const destinationPath = join(providerRoot, 'private-skill')
    await mkdir(canonicalPath, { recursive: true })
    await mkdir(destinationPath, { recursive: true })
    await writeFile(join(canonicalPath, 'SKILL.md'), 'new skill')
    await writeFile(join(destinationPath, 'SKILL.md'), 'old skill')
    const previousDigest = (await nativeSkillInstallFilesystem.observeSkill(destinationPath))
      .observedDigest
    const nextDigest = (await nativeSkillInstallFilesystem.observeSkill(canonicalPath))
      .observedDigest
    const previous = receipt(canonicalPath, previousDigest)
    previous.placements = [
      {
        provider: 'claude',
        path: destinationPath,
        topology: 'independent-copy',
        status: 'skipped'
      }
    ]

    const result = await reconcileSkillProviderPlacement({
      canonicalPath,
      skillName: 'private-skill',
      destination: { provider: 'claude', rootPath: providerRoot, readsCanonicalRoot: false },
      previousReceipt: previous,
      packageDigest: nextDigest
    })

    expect(result).toMatchObject({ status: 'skipped', errorCategory: 'skill-placement-unowned' })
    expect(await readFile(join(destinationPath, 'SKILL.md'), 'utf8')).toBe('old skill')
  })
})
