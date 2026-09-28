import type { AutomationRun } from '../../../shared/automations-types'
import type {
  AsyncProfileStateAuthority,
  ProfileStateDomainReplacement,
  ProfileStateMaintenance
} from '../loading-store/profile-state-authority'
import { ProfileStateBackupRotation } from './profile-state-backup-rotation'
import { runProfileStateBackupWorker } from './profile-state-backup-worker'
import { quarantineProfileStateDatabase } from './profile-state-database-quarantine'
import {
  ProfileStateWriteWorkerClient,
  type ProfileStateWriterInitialization
} from './profile-state-writer-worker-client'

/** Main owns backup scheduling; the persistent worker owns every live SQL command. */
export class ProfileStateWorkerAuthority implements AsyncProfileStateAuthority {
  readonly asynchronous = true
  private writer: ProfileStateWriteWorkerClient
  private backups: ProfileStateBackupRotation
  private closing: Promise<void> | undefined

  constructor(
    private readonly initialization: ProfileStateWriterInitialization,
    private readonly options: {
      workerPath?: string
      backupWorkerPath?: string
      onFailure?: (error: Error) => void
    } = {}
  ) {
    this.writer = new ProfileStateWriteWorkerClient(initialization, options)
    this.backups = this.createBackups()
  }

  get ready(): Promise<void> {
    return this.writer.ready
  }

  readSerializedState(): never {
    throw new Error('Live profile state requires its admitted startup snapshot')
  }

  assertWritable(): void {
    this.writer.assertWritable()
  }

  abort(): Promise<void> {
    return this.writer.abort()
  }

  assertCurrentRevision(): Promise<void> {
    return this.writer.assertCurrentRevision().then(() => {})
  }

  writeSerializedDomains(replacements: readonly ProfileStateDomainReplacement[]): Promise<void> {
    return this.writer.writeSerializedDomains(replacements).then(() => {})
  }

  writeSerializedAutomationRuns(
    replacements: readonly ProfileStateDomainReplacement[],
    runs: readonly AutomationRun[]
  ): Promise<void> {
    return this.writer.writeSerializedAutomationRuns(replacements, runs).then(() => {})
  }

  writeCompleteSerializedDomains(
    replacements: readonly ProfileStateDomainReplacement[]
  ): Promise<void> {
    return this.writer.writeCompleteSerializedDomains(replacements).then(() => {})
  }

  writeSerializedState(payload: Buffer): Promise<void> {
    return this.writer.writeSerializedState(payload).then(() => {})
  }

  writeJsonExport(targetPath: string): Promise<number> {
    return this.writer.writeJsonExport(targetPath)
  }

  writeLatestJsonExport(dataFile: string): Promise<number | undefined> {
    return this.writer.writeLatestJsonExport(dataFile)
  }

  writeJsonCompatibilityExport(targetPath: string): Promise<number | undefined> {
    return this.writer.writeJsonCompatibilityExportAsync(targetPath)
  }

  writeJsonCompatibilityExportAsync(targetPath: string): Promise<number | undefined> {
    return this.writeJsonCompatibilityExport(targetPath)
  }

  scheduleBackup(): void {
    if (!this.closing) {
      this.backups.schedule()
    }
  }

  drainBackups(cancel = false): Promise<void> {
    if (cancel) {
      this.backups.stop()
    }
    return this.backups.drain()
  }

  close(): Promise<void> {
    this.writer.stopAdmission()
    this.closing ??= this.finishClose()
    return this.closing
  }

  async pauseForMaintenance(): Promise<ProfileStateMaintenance> {
    this.assertWritable()
    const writer = this.writer
    await this.close()
    const revision = writer.acknowledgedRevision
    let consumed = false
    return {
      resume: async () => {
        if (consumed || this.writer !== writer) {
          throw new Error('Profile maintenance resume has already been consumed')
        }
        consumed = true
        this.writer = new ProfileStateWriteWorkerClient(
          { ...this.initialization, revision },
          { ...this.options, reportInitializationFailure: true }
        )
        this.backups = this.createBackups()
        this.closing = undefined
        try {
          await this.writer.ready
          this.assertWritable()
        } catch (error) {
          await this.close()
          throw error
        }
      }
    }
  }

  async quarantineDatabase(quarantineRoot?: string, reason?: string) {
    await this.close()
    return quarantineProfileStateDatabase(
      this.initialization.databasePath,
      this.initialization.profileId,
      quarantineRoot,
      reason
    )
  }

  private async finishClose(): Promise<void> {
    this.backups.stop()
    const settled = await Promise.allSettled([this.backups.drain(), this.writer.close()])
    for (const result of settled) {
      if (result.status === 'rejected') {
        throw result.reason
      }
    }
  }

  private createBackups(): ProfileStateBackupRotation {
    return new ProfileStateBackupRotation(
      this.initialization.databasePath,
      this.initialization.profileId,
      Date.now,
      (job, signal) =>
        runProfileStateBackupWorker(job, { workerPath: this.options.backupWorkerPath, signal })
    )
  }
}
