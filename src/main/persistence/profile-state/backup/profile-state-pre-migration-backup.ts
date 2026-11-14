import { lstat } from 'node:fs/promises'
import { runProfileStateBackup } from './profile-state-backup-worker'

/** Failed backups must block data migration. */
export type ProfileStatePreMigrationBackup = 'ready' | 'failed'

/** Outside hourly rotation; retire this artifact and crash temporaries with the layout migration. */
export function profileStatePreMigrationBackupPath(databaseFile: string): string {
  return `${databaseFile}.pre-migration.db`
}

/** Single live owner only: copy once before boot-time rewrites and preserve that original across boots. */
export async function ensureProfileStatePreMigrationBackup(
  databaseFile: string,
  profileId: string,
  runBackup = runProfileStateBackup
): Promise<ProfileStatePreMigrationBackup> {
  const targetPath = profileStatePreMigrationBackupPath(databaseFile)
  try {
    const existing = await lstat(targetPath).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined
      }
      throw error
    })
    if (existing !== undefined) {
      // Only validated/fsynced copies are published; never replace the original.
      return existing.isFile() ? 'ready' : 'failed'
    }
    await runBackup({ databasePath: databaseFile, profileId, targetPath })
    return 'ready'
  } catch (error) {
    console.error('[persistence] Could not back up the profile before migrating saved data:', error)
    return 'failed'
  }
}
