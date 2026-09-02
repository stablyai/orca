import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSkillPackageArchive } from './skill-package-creation'
import { extractSkillPackageArchive } from './skill-package-extraction'
import { skillInstallLockPath } from './skill-install-lock'
import { beginSkillExtractionRecovery } from './skill-extraction-recovery'
import {
  readSkillInstallReceipt,
  removeSkillInstallReceipt,
  writeSkillStateFile,
  type SkillInstallReceiptV1
} from './skill-install-provenance'
import { skillInstallJournalPath, type SkillInstallJournalV1 } from './skill-install-recovery'
import { installLocalSkillPackage } from './skill-install-transaction'
import { skillRemovalJournalPath, type SkillRemovalJournalV1 } from './skill-remove-recovery'
import { recoverPendingSkillTransactions } from './skill-transaction-startup-recovery'

const roots: string[] = []

async function packageVersion(root: string, name: string, versionId: string, body: string) {
  const source = join(root, `${name}-${versionId}`)
  await mkdir(source)
  await writeFile(
    join(source, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Recovery\n---\n\n${body}\n`
  )
  return createSkillPackageArchive({
    sourceDirectory: source,
    archivePath: join(root, `${name}-${versionId}.tar.gz`),
    packageId: `package_${name}`,
    versionId
  })
}

async function install(
  root: string,
  name: string,
  versionId: string,
  body: string
): Promise<{ archive: Awaited<ReturnType<typeof packageVersion>>; canonicalPath: string }> {
  const archive = await packageVersion(root, name, versionId, body)
  const destinationRoot = join(root, 'skills')
  await installLocalSkillPackage({
    operationId: `install-${name}-${versionId}`,
    archivePath: archive.archivePath,
    destinationRoot,
    stateDirectory: join(root, 'state'),
    scope: 'global',
    destinationIdentity: 'global:test',
    hostIdentity: 'test',
    expectedPackageDigest: archive.manifest.packageDigest
  })
  return { archive, canonicalPath: join(destinationRoot, name) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('skill transaction startup recovery', () => {
  it('cleans extraction bytes and a dead lock left before the first install journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-startup-extraction-test-'))
    roots.push(root)
    const stateDirectory = join(root, 'state')
    const destinationRoot = join(root, 'skills')
    const canonicalPath = join(destinationRoot, 'alpha')
    const extraction = await beginSkillExtractionRecovery(stateDirectory, destinationRoot)
    await mkdir(extraction.extractionPath, { recursive: true })
    await writeFile(join(extraction.extractionPath, 'partial'), 'partial bytes')
    const lockPath = skillInstallLockPath(stateDirectory, canonicalPath)
    await mkdir(dirname(lockPath), { recursive: true })
    await writeFile(
      lockPath,
      JSON.stringify({ token: 'killed', pid: 2_147_483_647, createdAt: Date.now() })
    )

    const report = await recoverPendingSkillTransactions(stateDirectory)

    expect(report).toMatchObject({ scanned: 1, recovered: 1, failures: [], truncated: false })
    await expect(readFile(join(extraction.extractionPath, 'partial'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves bytes referenced by an extraction journal outside its destination root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-startup-extraction-boundary-test-'))
    roots.push(root)
    const stateDirectory = join(root, 'state')
    const extraction = await beginSkillExtractionRecovery(stateDirectory, join(root, 'skills'))
    const outsidePath = join(root, 'outside')
    await mkdir(outsidePath)
    await writeFile(join(outsidePath, 'keep'), 'owned elsewhere')
    const journalPath = join(stateDirectory, 'extraction-journals', `${extraction.ownerToken}.json`)
    await writeSkillStateFile(journalPath, { ...extraction, extractionPath: outsidePath })

    const report = await recoverPendingSkillTransactions(stateDirectory)

    expect(report).toMatchObject({
      scanned: 1,
      recovered: 0,
      failures: [{ journalKey: extraction.ownerToken, code: 'skill-extraction-journal-invalid' }]
    })
    expect(await readFile(join(outsidePath, 'keep'), 'utf8')).toBe('owned elsewhere')
    expect(JSON.parse(await readFile(journalPath, 'utf8'))).toMatchObject({
      extractionPath: outsidePath
    })
  })

  it('publishes a committed install after restart and reclaims its dead lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-startup-recovery-test-'))
    roots.push(root)
    const stateDirectory = join(root, 'state')
    const first = await install(root, 'alpha', 'version_1', '# First')
    const second = await packageVersion(root, 'alpha', 'version_2', '# Second')
    const previous = await readSkillInstallReceipt(stateDirectory, first.canonicalPath)
    if (!previous) {
      throw new Error('missing receipt')
    }
    const extractionPath = join(root, 'skills', '.orca-skill-extract-restart')
    const stagingPath = join(root, 'skills', '.alpha.orca-staging-restart')
    const backupPath = join(root, 'skills', '.alpha.orca-backup-restart')
    await extractSkillPackageArchive({
      archivePath: second.archivePath,
      destinationDirectory: extractionPath,
      expectedPackageDigest: second.manifest.packageDigest
    })
    await rename(join(extractionPath, 'skill'), stagingPath)
    await rename(first.canonicalPath, backupPath)
    await rename(stagingPath, first.canonicalPath)
    const receipt: SkillInstallReceiptV1 = {
      ...previous,
      versionId: second.manifest.versionId,
      packageDigest: second.manifest.packageDigest,
      archiveSha256: second.archiveSha256,
      fileModes: second.manifest.files
    }
    const journal: SkillInstallJournalV1 = {
      schemaVersion: 1,
      operation: 'install',
      phase: 'canonical-placed',
      canonicalPath: first.canonicalPath,
      extractionPath,
      stagingPath,
      backupPath,
      backupDigest: first.archive.manifest.packageDigest,
      stagingFileModes: second.manifest.files,
      backupFileModes: first.archive.manifest.files,
      receipt
    }
    await writeSkillStateFile(skillInstallJournalPath(stateDirectory, first.canonicalPath), journal)
    const lockPath = skillInstallLockPath(stateDirectory, first.canonicalPath)
    await mkdir(dirname(lockPath), { recursive: true })
    await writeFile(
      lockPath,
      JSON.stringify({ token: 'killed', pid: 2_147_483_647, createdAt: Date.now() })
    )

    const report = await recoverPendingSkillTransactions(stateDirectory)

    expect(report).toMatchObject({ scanned: 1, recovered: 1, failures: [], truncated: false })
    expect((await readSkillInstallReceipt(stateDirectory, first.canonicalPath))?.versionId).toBe(
      'version_2'
    )
    expect(await readFile(join(first.canonicalPath, 'SKILL.md'), 'utf8')).toContain('# Second')
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores an interrupted removal before exposing managed installs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-startup-removal-test-'))
    roots.push(root)
    const stateDirectory = join(root, 'state')
    const installed = await install(root, 'beta', 'version_1', '# Keep')
    const receipt = await readSkillInstallReceipt(stateDirectory, installed.canonicalPath)
    if (!receipt) {
      throw new Error('missing receipt')
    }
    const backupPath = join(root, 'skills', '.beta.orca-remove-backup-restart')
    await rename(installed.canonicalPath, backupPath)
    const journal: SkillRemovalJournalV1 = {
      schemaVersion: 1,
      operation: 'remove',
      phase: 'moving',
      canonicalPath: installed.canonicalPath,
      movedCount: 1,
      moves: [
        {
          sourcePath: installed.canonicalPath,
          backupPath,
          placement: {
            provider: 'agent-skills',
            path: installed.canonicalPath,
            topology: 'canonical-copy',
            status: 'installed'
          },
          expectedDigest: receipt.packageDigest
        }
      ],
      receipt,
      allowedProviderRoots: []
    }
    await writeSkillStateFile(
      skillRemovalJournalPath(stateDirectory, installed.canonicalPath),
      journal
    )
    await removeSkillInstallReceipt(stateDirectory, installed.canonicalPath)

    const report = await recoverPendingSkillTransactions(stateDirectory)

    expect(report).toMatchObject({ scanned: 1, recovered: 1, failures: [], truncated: false })
    expect(await readFile(join(installed.canonicalPath, 'SKILL.md'), 'utf8')).toContain('# Keep')
    expect(await readSkillInstallReceipt(stateDirectory, installed.canonicalPath)).toBeTruthy()
  })

  it('bounds corrupt journal scanning and leaves unknown files untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-startup-bounds-test-'))
    roots.push(root)
    const stateDirectory = join(root, 'state')
    const journalDirectory = join(stateDirectory, 'journals')
    await mkdir(journalDirectory, { recursive: true })
    await Promise.all(
      Array.from({ length: 65 }, (_, index) =>
        writeFile(join(journalDirectory, `${String(index).padStart(2, '0')}.json`), '{}')
      )
    )

    const report = await recoverPendingSkillTransactions(stateDirectory)

    expect(report).toMatchObject({ scanned: 0, recovered: 0, truncated: true })
    expect(report.failures).toHaveLength(64)
    expect(await readFile(join(journalDirectory, '00.json'), 'utf8')).toBe('{}')
  })
})
