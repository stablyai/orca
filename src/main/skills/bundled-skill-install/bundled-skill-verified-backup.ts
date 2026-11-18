import { cp, rm } from 'node:fs/promises'
import { nativeSkillInstallFilesystem } from '../filesystem/skill-install-filesystem'
import type { BundledSkillFilesystem } from './bundled-skill-filesystem'
import { filesystemErrorCode } from './bundled-skill-filesystem-error'
import { bundledSkillTreeSignature } from './bundled-skill-tree-signature'

export async function moveAcrossFilesystems(
  filesystem: BundledSkillFilesystem,
  source: string,
  target: string
): Promise<void> {
  try {
    await nativeSkillInstallFilesystem.rename(source, target)
    return
  } catch (error) {
    if (filesystemErrorCode(error) !== 'EXDEV') {
      throw error
    }
  }
  await cp(source, target, {
    recursive: true,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false
  })
  // Remove source only after proving backup contents match.
  if (
    (await bundledSkillTreeSignature(filesystem, source)) !==
    (await bundledSkillTreeSignature(filesystem, target))
  ) {
    throw Object.assign(new Error(`bundled-skill-backup-mismatch: ${target}`), { code: 'EBACKUP' })
  }
  await rm(source, { recursive: true, force: true })
}
