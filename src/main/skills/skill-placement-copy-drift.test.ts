import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillInstallReceiptV1 } from './skill-install-provenance'
import { nativeSkillInstallFilesystem } from './skill-install-filesystem'
import { reconcileSkillProviderPlacement } from './skill-placement-reconciliation'
import { isRemovableSkillPlacement } from './skill-removable-placement'

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-copy-drift-'))
  roots.push(root)
  const canonicalPath = join(root, 'canonical', 'private-skill')
  const providerRoot = join(root, 'provider')
  const placementPath = join(providerRoot, 'private-skill')
  await Promise.all([
    mkdir(canonicalPath, { recursive: true }),
    mkdir(placementPath, { recursive: true })
  ])
  await Promise.all([
    writeFile(join(canonicalPath, 'SKILL.md'), 'old skill'),
    writeFile(join(placementPath, 'SKILL.md'), 'old skill')
  ])
  const packageDigest = (await nativeSkillInstallFilesystem.observeSkill(canonicalPath))
    .observedDigest
  const receipt: SkillInstallReceiptV1 = {
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
        topology: 'independent-copy',
        status: 'installed'
      }
    ],
    installedAt: '2026-08-11T00:00:00.000Z',
    hostIdentity: 'test'
  }
  return { canonicalPath, providerRoot, placementPath, receipt }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('independent skill placement copy drift', () => {
  it('preserves a locally modified copy during update reconciliation', async () => {
    const value = await fixture()
    await writeFile(join(value.canonicalPath, 'SKILL.md'), 'new cloud version')
    await writeFile(join(value.placementPath, 'local.md'), 'local change')
    const packageDigest = (await nativeSkillInstallFilesystem.observeSkill(value.canonicalPath))
      .observedDigest

    const result = await reconcileSkillProviderPlacement({
      canonicalPath: value.canonicalPath,
      skillName: 'private-skill',
      destination: { provider: 'claude', rootPath: value.providerRoot, readsCanonicalRoot: false },
      previousReceipt: value.receipt,
      packageDigest
    })

    expect(result).toMatchObject({
      topology: 'independent-copy',
      status: 'skipped',
      errorCategory: 'skill-placement-modified-copy'
    })
    expect(await readFile(join(value.placementPath, 'local.md'), 'utf8')).toBe('local change')
  })

  it('refuses to remove a locally modified copy', async () => {
    const value = await fixture()
    await writeFile(join(value.placementPath, 'local.md'), 'local change')

    await expect(
      isRemovableSkillPlacement({
        placement: value.receipt.placements[0]!,
        receipt: value.receipt,
        allowedProviderRoots: [value.providerRoot],
        filesystem: nativeSkillInstallFilesystem
      })
    ).resolves.toBe(false)
    expect(await readFile(join(value.placementPath, 'local.md'), 'utf8')).toBe('local change')
  })
})
