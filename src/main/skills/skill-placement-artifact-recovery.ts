import { lstat, readlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { SkillInstalledFileMode, SkillInstallFilesystem } from './skill-install-filesystem'
import type {
  SkillPlacementJournalActionV1,
  SkillPlacementJournalV1
} from './skill-placement-recovery-journal'

function normalizedPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

export async function placementPathExists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => null))
}

export async function placementIsAlias(
  canonicalPath: string,
  destinationPath: string,
  filesystem: SkillInstallFilesystem
): Promise<boolean> {
  if (filesystem.aliasTargets) {
    return filesystem.aliasTargets(canonicalPath, destinationPath).catch(() => false)
  }
  return Boolean((await lstat(destinationPath).catch(() => null))?.isSymbolicLink())
}

export async function placementMatchesDigest(
  path: string,
  digest: string,
  journal: SkillPlacementJournalV1,
  filesystem: SkillInstallFilesystem,
  fileModes: readonly SkillInstalledFileMode[] = journal.fileModes
): Promise<boolean> {
  return (
    (await filesystem.observeSkill(path, fileModes).catch(() => null))?.observedDigest === digest
  )
}

export async function placementBackupMatchesPrevious(
  journal: SkillPlacementJournalV1,
  action: SkillPlacementJournalActionV1,
  filesystem: SkillInstallFilesystem
): Promise<boolean> {
  const previous = journal.previousReceipt?.placements.find(
    (placement) => normalizedPath(placement.path) === normalizedPath(action.destinationPath)
  )
  if (!previous || !journal.previousReceipt) {
    return false
  }
  if (previous.topology !== 'provider-alias') {
    return placementMatchesDigest(
      action.backupPath,
      journal.previousReceipt.packageDigest,
      journal,
      filesystem,
      journal.previousReceipt.fileModes ?? []
    )
  }
  if (filesystem.aliasTargets) {
    return filesystem.aliasTargets(journal.canonicalPath, action.backupPath).catch(() => false)
  }
  const target = await readlink(action.backupPath).catch(() => null)
  return Boolean(
    target &&
    normalizedPath(resolve(dirname(action.backupPath), target)) ===
      normalizedPath(journal.canonicalPath)
  )
}

export async function settleDesiredPlacementArtifacts(
  journal: SkillPlacementJournalV1,
  action: SkillPlacementJournalActionV1,
  filesystem: SkillInstallFilesystem
): Promise<boolean> {
  const [destinationExists, stagingExists, backupExists] = await Promise.all([
    placementPathExists(action.destinationPath),
    placementPathExists(action.stagingPath),
    placementPathExists(action.backupPath)
  ])
  if (backupExists) {
    if (!(await placementBackupMatchesPrevious(journal, action, filesystem))) {
      throw new Error('skill-placement-recovery-conflict')
    }
    if (destinationExists) {
      if (
        !(await placementMatchesDigest(
          action.destinationPath,
          journal.packageDigest,
          journal,
          filesystem
        ))
      ) {
        throw new Error('skill-placement-recovery-conflict')
      }
      await filesystem.remove(action.backupPath)
    } else if (
      stagingExists &&
      (await placementMatchesDigest(action.stagingPath, journal.packageDigest, journal, filesystem))
    ) {
      await filesystem.rename(action.stagingPath, action.destinationPath)
      await filesystem.remove(action.backupPath)
      return true
    } else {
      if (stagingExists) {
        await filesystem.remove(action.stagingPath)
      }
      await filesystem.rename(action.backupPath, action.destinationPath)
    }
  }
  if (await placementPathExists(action.stagingPath)) {
    if (
      !(await placementMatchesDigest(
        action.stagingPath,
        journal.packageDigest,
        journal,
        filesystem
      ))
    ) {
      await filesystem.remove(action.stagingPath)
      return true
    }
    await ((await placementPathExists(action.destinationPath))
      ? filesystem.remove(action.stagingPath)
      : filesystem.rename(action.stagingPath, action.destinationPath))
  }
  return stagingExists || backupExists
}
