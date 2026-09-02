import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSkillPackageArchive } from './skill-package-creation'
import { extractSkillPackageArchive } from './skill-package-extraction'
import {
  readSkillInstallReceipt,
  writeSkillInstallReceipt,
  writeSkillStateFile,
  type SkillInstallReceiptV1
} from './skill-install-provenance'
import {
  recoverSkillInstallTransaction,
  skillInstallJournalPath,
  type SkillInstallJournalV1
} from './skill-install-recovery'
import { installLocalSkillPackage } from './skill-install-transaction'

const roots: string[] = []

async function packageVersion(root: string, versionId: string, body: string) {
  const source = join(root, `source-${versionId}`)
  await mkdir(source)
  await writeFile(
    join(source, 'SKILL.md'),
    `---\nname: recovery-skill\ndescription: Recovery\n---\n\n${body}\n`
  )
  return createSkillPackageArchive({
    sourceDirectory: source,
    archivePath: join(root, `${versionId}.tar.gz`),
    packageId: 'package_1',
    versionId
  })
}

async function interruptedUpdate(phase: SkillInstallJournalV1['phase']): Promise<{
  root: string
  canonicalPath: string
  stateDirectory: string
  journal: SkillInstallJournalV1
}> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-recovery-test-'))
  roots.push(root)
  const first = await packageVersion(root, 'version_1', '# First')
  const second = await packageVersion(root, 'version_2', '# Second')
  const destinationRoot = join(root, 'skills')
  const stateDirectory = join(root, 'state')
  const input = {
    operationId: 'install-first',
    archivePath: first.archivePath,
    destinationRoot,
    stateDirectory,
    scope: 'global' as const,
    destinationIdentity: 'global:test',
    hostIdentity: 'test',
    expectedPackageDigest: first.manifest.packageDigest
  }
  await installLocalSkillPackage(input)
  const canonicalPath = join(destinationRoot, 'recovery-skill')
  const previous = await readSkillInstallReceipt(stateDirectory, canonicalPath)
  if (!previous) {
    throw new Error('fixture receipt missing')
  }
  const extractionPath = join(destinationRoot, '.orca-skill-extract-recovery')
  const stagingPath = join(destinationRoot, '.recovery-skill.orca-staging-recovery')
  const backupPath = join(destinationRoot, '.recovery-skill.orca-backup-recovery')
  await extractSkillPackageArchive({
    archivePath: second.archivePath,
    destinationDirectory: extractionPath,
    expectedPackageDigest: second.manifest.packageDigest
  })
  await rename(join(extractionPath, 'skill'), stagingPath)
  await rename(canonicalPath, backupPath)
  await rename(stagingPath, canonicalPath)
  const receipt: SkillInstallReceiptV1 = {
    ...previous,
    versionId: second.manifest.versionId,
    packageDigest: second.manifest.packageDigest,
    archiveSha256: second.archiveSha256,
    previousVersionId: previous.versionId,
    installedAt: new Date().toISOString(),
    fileModes: second.manifest.files.map((file) => ({
      path: file.path,
      executable: file.executable
    }))
  }
  const journal: SkillInstallJournalV1 = {
    schemaVersion: 1,
    operation: 'install',
    phase,
    canonicalPath,
    extractionPath,
    stagingPath,
    backupPath,
    backupDigest: first.manifest.packageDigest,
    stagingFileModes: second.manifest.files,
    backupFileModes: first.manifest.files,
    receipt
  }
  await writeSkillStateFile(skillInstallJournalPath(stateDirectory, canonicalPath), journal)
  return { root, canonicalPath, stateDirectory, journal }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('skill install recovery', () => {
  it('publishes provenance for a placed destination that has no new receipt', async () => {
    const fixture = await interruptedUpdate('canonical-placed')

    await recoverSkillInstallTransaction(fixture.stateDirectory, fixture.canonicalPath)

    expect(
      (await readSkillInstallReceipt(fixture.stateDirectory, fixture.canonicalPath))?.versionId
    ).toBe('version_2')
    expect(await readFile(join(fixture.canonicalPath, 'SKILL.md'), 'utf8')).toContain('# Second')
    await expect(readFile(fixture.journal.backupPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(skillInstallJournalPath(fixture.stateDirectory, fixture.canonicalPath))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('finalizes a published receipt with an incomplete journal', async () => {
    const fixture = await interruptedUpdate('receipt-published')
    await writeSkillInstallReceipt(fixture.stateDirectory, fixture.journal.receipt)

    await recoverSkillInstallTransaction(fixture.stateDirectory, fixture.canonicalPath)

    expect(
      (await readSkillInstallReceipt(fixture.stateDirectory, fixture.canonicalPath))?.versionId
    ).toBe('version_2')
    await expect(
      readFile(skillInstallJournalPath(fixture.stateDirectory, fixture.canonicalPath))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects journal paths outside the canonical parent without removing them', async () => {
    const fixture = await interruptedUpdate('canonical-placed')
    const outside = join(fixture.root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'keep.txt'), 'keep')
    await writeSkillStateFile(
      skillInstallJournalPath(fixture.stateDirectory, fixture.canonicalPath),
      {
        ...fixture.journal,
        backupPath: outside
      }
    )

    await expect(
      recoverSkillInstallTransaction(fixture.stateDirectory, fixture.canonicalPath)
    ).rejects.toThrow('skill-install-journal-invalid')
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('preserves a journal path whose bytes no longer match the recorded identity', async () => {
    const fixture = await interruptedUpdate('canonical-placed')
    await writeFile(join(fixture.journal.backupPath, 'local.md'), 'changed after crash')

    await expect(
      recoverSkillInstallTransaction(fixture.stateDirectory, fixture.canonicalPath)
    ).rejects.toThrow('skill-install-recovery-conflict')
    expect(await readFile(join(fixture.journal.backupPath, 'local.md'), 'utf8')).toBe(
      'changed after crash'
    )
  })
})
