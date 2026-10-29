import { lstat, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import {
  skillInstallStateKey,
  writeSkillInstallReceipt,
  type SkillInstallReceiptV1
} from './skill-install-provenance'
import {
  nativeSkillInstallFilesystem,
  type SkillInstallFilesystem,
  type SkillInstalledFileMode
} from './skill-install-filesystem'

type InstallJournalPhase =
  | 'prepared'
  | 'backup-created'
  | 'canonical-placed'
  | 'receipt-published'
  | 'complete'

const SKILL_TRANSACTION_JOURNAL_MAX_BYTES = 4 * 1024 * 1024

export type SkillInstallJournalV1 = {
  schemaVersion: 1
  operation: 'install'
  phase: InstallJournalPhase
  canonicalPath: string
  extractionPath: string
  stagingPath: string
  backupPath: string
  backupDigest: string | null
  stagingFileModes: SkillInstalledFileMode[]
  backupFileModes: SkillInstalledFileMode[]
  receipt: SkillInstallReceiptV1
}

export function skillInstallJournalPath(stateDirectory: string, canonicalPath: string): string {
  return join(stateDirectory, 'journals', `${skillInstallStateKey(canonicalPath)}.json`)
}

export async function skillInstallPathExists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => null))
}

function isInstallJournal(value: unknown, canonicalPath: string): value is SkillInstallJournalV1 {
  if (!value || typeof value !== 'object') {
    return false
  }
  const journal = value as Partial<SkillInstallJournalV1>
  const parent = dirname(resolve(canonicalPath))
  const name = basename(canonicalPath)
  const ownedPath = (path: unknown, prefix: string): path is string =>
    typeof path === 'string' &&
    dirname(resolve(path)) === parent &&
    basename(path).startsWith(prefix)
  return (
    journal.schemaVersion === 1 &&
    journal.operation === 'install' &&
    typeof journal.phase === 'string' &&
    journal.canonicalPath === canonicalPath &&
    ownedPath(journal.extractionPath, '.orca-skill-extract-') &&
    ownedPath(journal.stagingPath, `.${name}.orca-staging-`) &&
    ownedPath(journal.backupPath, `.${name}.orca-backup-`) &&
    journal.extractionPath !== journal.stagingPath &&
    journal.extractionPath !== journal.backupPath &&
    journal.stagingPath !== journal.backupPath &&
    (journal.backupDigest === null ||
      (typeof journal.backupDigest === 'string' && /^[a-f0-9]{64}$/.test(journal.backupDigest))) &&
    Array.isArray(journal.stagingFileModes) &&
    Array.isArray(journal.backupFileModes) &&
    [...journal.stagingFileModes, ...journal.backupFileModes].every(
      (file) => typeof file.path === 'string' && typeof file.executable === 'boolean'
    ) &&
    Boolean(journal.receipt) &&
    journal.receipt?.canonicalPath === canonicalPath &&
    typeof journal.receipt?.packageDigest === 'string'
  )
}

export async function readSkillInstallRecoveryJournal(
  stateDirectory: string,
  canonicalPath: string
): Promise<SkillInstallJournalV1 | null> {
  try {
    const value: unknown = JSON.parse(
      (
        await readNodeFileWithinLimit(
          skillInstallJournalPath(stateDirectory, canonicalPath),
          SKILL_TRANSACTION_JOURNAL_MAX_BYTES
        )
      ).buffer.toString('utf8')
    )
    if (!isInstallJournal(value, canonicalPath)) {
      throw new Error('skill-install-journal-invalid')
    }
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export async function skillInstallDestinationMatches(
  path: string,
  digest: string,
  filesystem: SkillInstallFilesystem = nativeSkillInstallFilesystem,
  files?: readonly SkillInstalledFileMode[]
): Promise<boolean> {
  try {
    return (await filesystem.observeSkill(path, files)).observedDigest === digest
  } catch {
    return false
  }
}

export async function cleanSkillInstallJournalFiles(
  journal: SkillInstallJournalV1,
  filesystem: SkillInstallFilesystem = nativeSkillInstallFilesystem
): Promise<void> {
  await filesystem.remove(journal.extractionPath)
  await removeJournalOwnedSkill(
    journal.stagingPath,
    journal.receipt.packageDigest,
    journal.stagingFileModes,
    filesystem
  )
  await removeJournalOwnedSkill(
    journal.backupPath,
    journal.backupDigest,
    journal.backupFileModes,
    filesystem
  )
}

async function removeJournalOwnedSkill(
  path: string,
  expectedDigest: string | null,
  files: readonly SkillInstalledFileMode[],
  filesystem: SkillInstallFilesystem
): Promise<void> {
  if (!(await skillInstallPathExists(path))) {
    return
  }
  if (
    !expectedDigest ||
    !(await skillInstallDestinationMatches(path, expectedDigest, filesystem, files))
  ) {
    throw new Error('skill-install-recovery-conflict')
  }
  await filesystem.remove(path)
}

export async function recoverSkillInstallTransaction(
  stateDirectory: string,
  canonicalPath: string,
  filesystem: SkillInstallFilesystem = nativeSkillInstallFilesystem
): Promise<void> {
  const journal = await readSkillInstallRecoveryJournal(stateDirectory, canonicalPath)
  if (!journal) {
    return
  }
  const destinationExists = await skillInstallPathExists(canonicalPath)
  const backupExists = await skillInstallPathExists(journal.backupPath)
  const destinationIsRequested =
    destinationExists &&
    (await skillInstallDestinationMatches(
      canonicalPath,
      journal.receipt.packageDigest,
      filesystem,
      journal.receipt.fileModes
    ))

  if (destinationIsRequested) {
    await writeSkillInstallReceipt(stateDirectory, journal.receipt)
    await cleanSkillInstallJournalFiles(journal, filesystem)
    await rm(skillInstallJournalPath(stateDirectory, canonicalPath), { force: true })
    return
  }
  if (!destinationExists && backupExists) {
    if (
      !journal.backupDigest ||
      !(await skillInstallDestinationMatches(
        journal.backupPath,
        journal.backupDigest,
        filesystem,
        journal.backupFileModes
      ))
    ) {
      throw new Error('skill-install-recovery-conflict')
    }
    await filesystem.rename(journal.backupPath, canonicalPath)
    await filesystem.remove(journal.extractionPath)
    await filesystem.remove(journal.stagingPath)
    await rm(skillInstallJournalPath(stateDirectory, canonicalPath), { force: true })
    return
  }
  if (journal.phase === 'prepared' && !backupExists) {
    await cleanSkillInstallJournalFiles(journal, filesystem)
    await rm(skillInstallJournalPath(stateDirectory, canonicalPath), { force: true })
    return
  }
  throw new Error('skill-install-recovery-conflict')
}
