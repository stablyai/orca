import { profileStateDatabaseFiles } from './profile-state-storage-classification'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { bestEffortFsyncDirectorySync, fsyncFileSync } from '../../../shared/secure-file'
import { durableWriteTempPath, writeFileDurableSync } from '../../durable-file-write'
import { hardenSqliteDatabaseFiles } from '../../sqlite/harden-database-files'
import { copyProfileStateRecoveryFiles } from './profile-state-recovery-copy'

export type ProfileStateDatabaseQuarantine = {
  directory: string
  manifestPath: string
  copiedFiles: readonly string[]
}

/**
 * Preserve a damaged profile database family before a caller attempts repair or fallback.
 * Originals remain in place so this operation cannot turn a recovery failure into data loss.
 */
export function quarantineProfileStateDatabase(
  databasePath: string,
  profileId: string,
  quarantineRoot = dirname(databasePath),
  reason = 'profile-state-database-recovery',
  recoveryFiles: readonly string[] = []
): ProfileStateDatabaseQuarantine {
  if (databasePath.length === 0 || databasePath.includes('\0') || profileId.length === 0) {
    throw new Error('Profile state quarantine arguments are invalid')
  }
  const sourceFiles = profileStateDatabaseFiles(databasePath).filter(existsSync)
  if (sourceFiles.length === 0 && recoveryFiles.length === 0) {
    throw new Error('Profile state database family does not exist')
  }

  const directory = join(quarantineRoot, `profile-state-corrupt-${Date.now()}-${randomUUID()}`)
  const targets = new Set<string>()
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    const copies: { source: string; target: string }[] = []
    for (const sourcePath of sourceFiles) {
      const targetName =
        sourcePath === databasePath
          ? 'profile-state.db'
          : `profile-state.db${sourcePath.slice(databasePath.length)}`
      const targetPath = join(directory, targetName)
      copies.push({ source: sourcePath, target: targetPath })
      targets.add(targetPath)
    }
    for (const sourcePath of new Set(recoveryFiles)) {
      const targetPath = join(directory, basename(sourcePath))
      if (
        targets.has(targetPath) ||
        existsSync(targetPath) ||
        basename(sourcePath) === 'manifest.json'
      ) {
        throw new Error('Profile recovery artifact name conflicts with the quarantine manifest')
      }
      copies.push({ source: sourcePath, target: targetPath })
      targets.add(targetPath)
    }
    copyProfileStateRecoveryFiles(copies)
    const manifestPath = join(directory, 'manifest.json')
    // Let the destination filesystem detect case or Unicode aliases of the manifest name.
    if (existsSync(manifestPath)) {
      throw new Error('Profile recovery artifact name conflicts with the quarantine manifest')
    }
    for (const { target } of copies) {
      hardenSqliteDatabaseFiles(target)
      fsyncFileSync(target)
    }
    writeFileDurableSync(
      durableWriteTempPath(manifestPath),
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        profileId,
        reason,
        capturedAt: new Date().toISOString(),
        sourceFiles: sourceFiles.map((sourcePath) => sourcePath.slice(databasePath.length)),
        recoveryFiles: [...new Set(recoveryFiles)].map((sourcePath) => basename(sourcePath))
      })
    )
    bestEffortFsyncDirectorySync(directory)
    return { directory, manifestPath, copiedFiles: [...targets] }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
