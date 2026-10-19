import { lstat } from 'node:fs/promises'
import { runProfileStateBackup } from './profile-state-backup-worker'

/** `ready`: the copy exists, so a migration may rewrite saved data. `failed`: do not migrate. */
export type ProfileStatePreMigrationBackup = 'ready' | 'failed'

/**
 * Outside the `.backup.` namespace, so the hourly rotation never prunes it. Delete it, and any
 * `.tmp` a crash mid-copy left, when the boot-time layout migration is retired.
 */
export function profileStatePreMigrationBackupPath(databaseFile: string): string {
  return `${databaseFile}.pre-migration.db`
}

/**
 * Copy the profile once, before the first boot-time rewrite of saved data; later boots find the
 * copy and keep it, so it stays the pre-migration state. Call from the profile's single live owner
 * (the instance lock keeps desktop and orcad apart), before any rewrite of this boot reaches disk.
 */
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
      // Only a validated, fsynced copy is ever renamed into place; never replace it.
      return existing.isFile() ? 'ready' : 'failed'
    }
    await runBackup({ databasePath: databaseFile, profileId, targetPath })
    return 'ready'
  } catch (error) {
    console.error('[persistence] Could not back up the profile before migrating saved data:', error)
    return 'failed'
  }
}
