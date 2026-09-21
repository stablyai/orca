import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillInstallReceiptV1 } from './skill-install-provenance'
import { reconcileSkillProviderPlacement } from './skill-placement-reconciliation'

const roots: string[] = []

async function fixture(): Promise<{
  root: string
  canonicalRoot: string
  canonicalPath: string
  packageDigest: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-alias-repair-test-'))
  roots.push(root)
  const canonicalRoot = join(root, 'canonical')
  const canonicalPath = join(canonicalRoot, 'private-skill')
  await mkdir(canonicalPath, { recursive: true })
  await writeFile(join(canonicalPath, 'SKILL.md'), 'private skill')
  const { nativeSkillInstallFilesystem } = await import('./skill-install-filesystem')
  const packageDigest = (await nativeSkillInstallFilesystem.observeSkill(canonicalPath))
    .observedDigest
  return { root, canonicalRoot, canonicalPath, packageDigest }
}

function receipt(
  canonicalPath: string,
  placementPath: string,
  packageDigest: string
): SkillInstallReceiptV1 {
  return {
    schemaVersion: 1,
    packageId: 'package_1',
    versionId: 'version_1',
    packageDigest,
    archiveSha256: 'a'.repeat(64),
    scope: 'global',
    destinationIdentity: 'global:test',
    canonicalPath,
    placements: [
      {
        provider: 'claude',
        path: placementPath,
        topology: 'provider-alias',
        status: 'installed'
      }
    ],
    installedAt: '2026-08-11T00:00:00.000Z',
    hostIdentity: 'test'
  }
}

function createDirectoryLink(target: string, path: string): Promise<void> {
  return symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('skill provider alias reconciliation', () => {
  it('detects a provider parent already linked to canonical storage', async () => {
    const value = await fixture()
    const providerRoot = join(value.root, 'provider')
    await createDirectoryLink(value.canonicalRoot, providerRoot)
    expect(await realpath(join(providerRoot, 'private-skill'))).toBe(
      await realpath(value.canonicalPath)
    )

    const result = await reconcileSkillProviderPlacement({
      canonicalPath: value.canonicalPath,
      skillName: 'private-skill',
      destination: { provider: 'claude', rootPath: providerRoot, readsCanonicalRoot: false },
      previousReceipt: null,
      packageDigest: value.packageDigest
    })

    expect(result).toMatchObject({ topology: 'provider-alias', status: 'unchanged' })
  })

  it('repairs a broken Orca-owned alias', async () => {
    const value = await fixture()
    const providerRoot = join(value.root, 'provider')
    const placementPath = join(providerRoot, 'private-skill')
    await mkdir(providerRoot)
    await createDirectoryLink(join(value.root, 'missing-skill'), placementPath)

    const result = await reconcileSkillProviderPlacement({
      canonicalPath: value.canonicalPath,
      skillName: 'private-skill',
      destination: { provider: 'claude', rootPath: providerRoot, readsCanonicalRoot: false },
      previousReceipt: receipt(value.canonicalPath, placementPath, value.packageDigest),
      packageDigest: value.packageDigest
    })

    expect(result).toMatchObject({ topology: 'provider-alias', status: 'installed' })
    expect(await realpath(placementPath)).toBe(await realpath(value.canonicalPath))
  })

  it.each([
    ['external', true],
    ['broken', false]
  ] as const)('preserves an unowned %s link', async (label, createTarget) => {
    const value = await fixture()
    const providerRoot = join(value.root, 'provider')
    const placementPath = join(providerRoot, 'private-skill')
    const target = join(value.root, `${label}-target`)
    await mkdir(providerRoot)
    if (createTarget) {
      await mkdir(target)
      await writeFile(join(target, 'SKILL.md'), 'external skill')
    }
    await createDirectoryLink(target, placementPath)

    const result = await reconcileSkillProviderPlacement({
      canonicalPath: value.canonicalPath,
      skillName: 'private-skill',
      destination: { provider: 'claude', rootPath: providerRoot, readsCanonicalRoot: false },
      previousReceipt: null,
      packageDigest: value.packageDigest
    })

    expect(result).toMatchObject({
      topology: 'provider-alias',
      status: 'skipped',
      errorCategory: 'skill-placement-unowned-link'
    })
    expect((await lstat(placementPath)).isSymbolicLink()).toBe(true)
  })
})
