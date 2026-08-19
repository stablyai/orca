import { randomUUID } from 'node:crypto'
import { cp, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SkillInstalledFileMode, SkillInstallFilesystem } from './skill-install-filesystem'

export async function createVerifiedSkillPlacementCopy(
  canonicalPath: string,
  destinationPath: string,
  filesystem: SkillInstallFilesystem,
  fileModes?: readonly SkillInstalledFileMode[]
): Promise<void> {
  const temporary = `${destinationPath}.orca-copy-${randomUUID()}`
  try {
    await cp(canonicalPath, temporary, { recursive: true, verbatimSymlinks: true })
    const [source, copied] = await Promise.all([
      filesystem.observeSkill(canonicalPath, fileModes),
      filesystem.observeSkill(temporary, fileModes)
    ])
    if (source.observedDigest !== copied.observedDigest) {
      throw new Error('skill-placement-copy-digest-mismatch')
    }
    await filesystem.rename(temporary, destinationPath)
  } finally {
    await filesystem.remove(temporary)
  }
}

export async function replaceOwnedSkillPlacementCopy(
  canonicalPath: string,
  destinationPath: string,
  filesystem: SkillInstallFilesystem,
  fileModes?: readonly SkillInstalledFileMode[],
  transaction?: { replacementPath: string; backupPath: string; retainBackup: boolean }
): Promise<void> {
  const replacement = transaction?.replacementPath ?? `${destinationPath}.orca-copy-${randomUUID()}`
  const backup = transaction?.backupPath ?? `${destinationPath}.orca-backup-${randomUUID()}`
  try {
    await (transaction
      ? createSkillPlacementCopyAtMissingDestination(
          canonicalPath,
          replacement,
          filesystem,
          fileModes
        )
      : createVerifiedSkillPlacementCopy(canonicalPath, replacement, filesystem, fileModes))
    await filesystem.rename(destinationPath, backup)
    try {
      await filesystem.rename(replacement, destinationPath)
    } catch (error) {
      await filesystem.rename(backup, destinationPath)
      throw error
    }
    if (!transaction?.retainBackup) {
      await filesystem.remove(backup)
    }
  } finally {
    await filesystem.remove(replacement)
  }
}

export async function createSkillPlacementCopyAtMissingDestination(
  canonicalPath: string,
  destinationPath: string,
  filesystem: SkillInstallFilesystem,
  fileModes?: readonly SkillInstalledFileMode[],
  stagingPath?: string
): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true })
  const copyPath = stagingPath ?? destinationPath
  await mkdir(copyPath, { mode: 0o700 })
  let complete = false
  let placed = false
  try {
    for (const entry of await readdir(canonicalPath)) {
      await cp(join(canonicalPath, entry), join(copyPath, entry), {
        recursive: true,
        verbatimSymlinks: true,
        force: false,
        errorOnExist: true
      })
    }
    const [source, copied] = await Promise.all([
      filesystem.observeSkill(canonicalPath, fileModes),
      filesystem.observeSkill(copyPath, fileModes)
    ])
    if (source.observedDigest !== copied.observedDigest) {
      throw new Error('skill-placement-copy-digest-mismatch')
    }
    if (stagingPath) {
      await filesystem.rename(stagingPath, destinationPath)
      placed = true
      await filesystem.observeSkill(destinationPath, fileModes)
    }
    complete = true
  } finally {
    if (!complete) {
      await filesystem.remove(copyPath)
      if (placed) {
        await filesystem.remove(destinationPath)
      }
    }
  }
}
