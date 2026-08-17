import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSkillPackageArchive } from './skill-package-creation'
import {
  readSkillInstallReceipt,
  writeSkillInstallReceipt,
  writeSkillStateFile,
  type SkillInstallReceiptV1
} from './skill-install-provenance'
import { installLocalSkillPackage } from './skill-install-transaction'
import {
  recoverSkillRemovalTransaction,
  removeLocalSharedSkill,
  skillRemovalJournalPath,
  type SkillRemovalJournalV1
} from './skill-remove-transaction'

const roots: string[] = []

async function installedFixture(): Promise<{
  root: string
  canonicalPath: string
  stateDirectory: string
  receipt: SkillInstallReceiptV1
}> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-remove-recovery-test-'))
  roots.push(root)
  const source = join(root, 'source')
  await mkdir(source)
  await writeFile(
    join(source, 'SKILL.md'),
    '---\nname: remove-skill\ndescription: Remove\n---\n\n# Remove\n'
  )
  const archive = await createSkillPackageArchive({
    sourceDirectory: source,
    archivePath: join(root, 'package.tar.gz'),
    packageId: 'package_1',
    versionId: 'version_1'
  })
  const destinationRoot = join(root, 'skills')
  const stateDirectory = join(root, 'state')
  await installLocalSkillPackage({
    operationId: 'install',
    archivePath: archive.archivePath,
    destinationRoot,
    stateDirectory,
    scope: 'global',
    destinationIdentity: 'global:test',
    hostIdentity: 'test'
  })
  const canonicalPath = join(destinationRoot, 'remove-skill')
  const receipt = await readSkillInstallReceipt(stateDirectory, canonicalPath)
  if (!receipt) {
    throw new Error('fixture receipt missing')
  }
  return { root, canonicalPath, stateDirectory, receipt }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('skill removal recovery', () => {
  it('rejects a journal-owned move outside its recorded provider roots', async () => {
    const fixture = await installedFixture()
    const outside = join(fixture.root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'keep.txt'), 'keep')
    const sourcePath = outside
    const backupPath = join(dirname(sourcePath), `.${basename(sourcePath)}.orca-remove-backup-x`)
    const journal: SkillRemovalJournalV1 = {
      schemaVersion: 1,
      operation: 'remove',
      phase: 'prepared',
      canonicalPath: fixture.canonicalPath,
      movedCount: 0,
      moves: [
        {
          sourcePath,
          backupPath,
          placement: {
            provider: 'claude',
            path: sourcePath,
            topology: 'independent-copy',
            status: 'installed'
          },
          expectedDigest: fixture.receipt.packageDigest
        }
      ],
      receipt: {
        ...fixture.receipt,
        placements: [
          ...fixture.receipt.placements,
          {
            provider: 'claude',
            path: sourcePath,
            topology: 'independent-copy',
            status: 'installed'
          }
        ]
      },
      allowedProviderRoots: []
    }
    await writeSkillStateFile(
      skillRemovalJournalPath(fixture.stateDirectory, fixture.canonicalPath),
      journal
    )

    await expect(
      recoverSkillRemovalTransaction(fixture.stateDirectory, fixture.canonicalPath)
    ).rejects.toThrow('skill-removal-journal-invalid')
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('preserves a moved backup whose bytes changed before recovery', async () => {
    const fixture = await installedFixture()
    const backupPath = join(
      dirname(fixture.canonicalPath),
      `.${basename(fixture.canonicalPath)}.orca-remove-backup-x`
    )
    await rename(fixture.canonicalPath, backupPath)
    await writeFile(join(backupPath, 'local.md'), 'changed')
    const journal: SkillRemovalJournalV1 = {
      schemaVersion: 1,
      operation: 'remove',
      phase: 'moving',
      canonicalPath: fixture.canonicalPath,
      movedCount: 1,
      moves: [
        {
          sourcePath: fixture.canonicalPath,
          backupPath,
          placement: {
            provider: 'agent-skills',
            path: fixture.canonicalPath,
            topology: 'canonical-copy',
            status: 'installed'
          },
          expectedDigest: fixture.receipt.packageDigest
        }
      ],
      receipt: fixture.receipt,
      allowedProviderRoots: []
    }
    await writeSkillStateFile(
      skillRemovalJournalPath(fixture.stateDirectory, fixture.canonicalPath),
      journal
    )

    await expect(
      recoverSkillRemovalTransaction(fixture.stateDirectory, fixture.canonicalPath)
    ).rejects.toThrow('skill-removal-recovery-conflict')
    expect(await readFile(join(backupPath, 'local.md'), 'utf8')).toBe('changed')
  })

  it('removes an owned placement after its provider config root changes', async () => {
    const fixture = await installedFixture()
    const oldProviderRoot = join(fixture.root, 'old-claude-config', 'skills')
    const oldPlacementPath = join(oldProviderRoot, basename(fixture.canonicalPath))
    await cp(fixture.canonicalPath, oldPlacementPath, { recursive: true })
    await writeSkillInstallReceipt(fixture.stateDirectory, {
      ...fixture.receipt,
      placements: [
        ...fixture.receipt.placements,
        {
          provider: 'claude',
          path: oldPlacementPath,
          topology: 'independent-copy',
          status: 'installed'
        }
      ]
    })

    await expect(
      removeLocalSharedSkill({
        operationId: 'remove-custom-root',
        canonicalPath: fixture.canonicalPath,
        stateDirectory: fixture.stateDirectory,
        allowedProviderRoots: [join(fixture.root, 'new-claude-config', 'skills')]
      })
    ).resolves.toMatchObject({ status: 'removed' })
    await expect(lstat(oldPlacementPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(
    ['prepared', 'moving', 'receipt-removed'].flatMap((phase) =>
      ['before', 'after'].map((boundary) => [phase, boundary] as const)
    )
  )('recovers failure %s the %s journal transition', async (phase, boundary) => {
    const fixture = await installedFixture()
    await expect(
      removeLocalSharedSkill(
        {
          operationId: 'remove',
          canonicalPath: fixture.canonicalPath,
          stateDirectory: fixture.stateDirectory,
          allowedProviderRoots: []
        },
        {
          onJournalTransition: async (currentPhase, currentBoundary) => {
            if (currentPhase === phase && currentBoundary === boundary) {
              throw new Error(`injected-${phase}-${boundary}`)
            }
          }
        }
      )
    ).rejects.toThrow(`injected-${phase}-${boundary}`)

    const canonicalExists = await readFile(join(fixture.canonicalPath, 'SKILL.md'), 'utf8')
      .then(() => true)
      .catch(() => false)
    const receipt = await readSkillInstallReceipt(fixture.stateDirectory, fixture.canonicalPath)
    expect(Boolean(receipt)).toBe(canonicalExists)
    await expect(
      readFile(skillRemovalJournalPath(fixture.stateDirectory, fixture.canonicalPath))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    if (canonicalExists) {
      await expect(
        removeLocalSharedSkill({
          operationId: 'retry-remove',
          canonicalPath: fixture.canonicalPath,
          stateDirectory: fixture.stateDirectory,
          allowedProviderRoots: []
        })
      ).resolves.toMatchObject({ status: 'removed' })
    }
  })
})
