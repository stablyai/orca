import { lstat, rm } from 'node:fs/promises'
import {
  createProfileStateDatabaseBackupId,
  profileStateDatabaseBackupPath,
  profileStateDatabaseBackupsAsync,
  type ProfileStateDatabaseBackup
} from './profile-state-backup-path'
import { runProfileStateBackup } from './profile-state-backup-worker'
import { removeAbandonedProfileStateBackupFiles } from './profile-state-backup-temporary-files'

const BACKUP_COUNT = 5
const BACKUP_INTERVAL_MS = 60 * 60 * 1000
const BACKUP_RETRY_MS = 60 * 1000

/** Immutable generations keep every previous recovery point until publication succeeds. */
export class ProfileStateBackupRotation {
  private pending: Promise<void> | undefined
  private stopped = false
  private readonly cancellation = new AbortController()
  private nextAttemptAt = 0

  constructor(
    private readonly databasePath: string,
    private readonly profileId: string,
    private readonly now: () => number = Date.now,
    private readonly runBackup = runProfileStateBackup
  ) {}

  schedule(): void {
    if (this.stopped || this.pending || this.now() < this.nextAttemptAt) {
      return
    }
    const pending = Promise.resolve()
      .then(() => this.rotate())
      .catch((error: unknown) => {
        this.nextAttemptAt = this.now() + BACKUP_RETRY_MS
        if (this.stopped && (this.cancellation.signal.aborted || isMissingPath(error))) {
          return
        }
        console.error('[persistence] Failed to back up profile state database:', error)
      })
      .finally(() => {
        if (this.pending === pending) {
          this.pending = undefined
        }
      })
    this.pending = pending
  }

  async drain(): Promise<void> {
    await this.pending
  }

  stop(): void {
    this.stopped = true
    this.cancellation.abort()
  }

  assertIdle(): void {
    if (this.pending) {
      throw new Error('Flush pending profile state backups before quarantining the database')
    }
  }

  private async rotate(): Promise<void> {
    if (this.stopped) {
      return
    }
    const now = this.now()
    await removeAbandonedProfileStateBackupFiles(this.databasePath, now)
    const latest = (await this.regularBackups())[0]
    if (this.stopped) {
      return
    }
    if (latest && now - latest.createdAtMs < BACKUP_INTERVAL_MS) {
      this.nextAttemptAt = Math.min(latest.createdAtMs, now) + BACKUP_INTERVAL_MS
      return
    }
    const target = profileStateDatabaseBackupPath(
      this.databasePath,
      createProfileStateDatabaseBackupId(now)
    )
    await this.runBackup(
      {
        databasePath: this.databasePath,
        profileId: this.profileId,
        targetPath: target
      },
      this.cancellation.signal
    )
    this.nextAttemptAt = this.now() + BACKUP_INTERVAL_MS
    for (const backup of (await this.regularBackups()).slice(BACKUP_COUNT)) {
      await rm(backup.path, { force: true })
    }
  }

  private async regularBackups(): Promise<readonly ProfileStateDatabaseBackup[]> {
    const backups = await profileStateDatabaseBackupsAsync(this.databasePath)
    const candidates = await Promise.all(
      backups.map(async (backup) => {
        try {
          if (!(await lstat(backup.path)).isFile()) {
            return undefined
          }
          for (const suffix of ['-wal', '-shm', '-journal']) {
            const sidecar = await lstat(`${backup.path}${suffix}`).catch((error: unknown) => {
              if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                return undefined
              }
              throw error
            })
            if (sidecar !== undefined) {
              return undefined
            }
          }
          return backup
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return undefined
          }
          throw error
        }
      })
    )
    return candidates.filter((backup) => backup !== undefined)
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
