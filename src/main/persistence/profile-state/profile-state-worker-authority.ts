import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import type {
  AsyncProfileStateAuthority,
  ProfileStateDomainReplacement,
  ProfileStateMaintenance
} from '../loading-store/profile-writing/profile-state-authority'
import { ProfileStateBackupRotation } from './backup/profile-state-backup-rotation'
import { runProfileStateBackupWorker } from './backup/profile-state-backup-worker'
import { quarantineProfileStateDatabase } from './recovery/profile-state-database-quarantine'
import type { ProfileStateWriteWorkerClient } from './writer/profile-state-writer-worker-client'
import {
  closedProfileStateWriterError,
  ProfileStateWriterError
} from './writer/profile-state-writer-errors'
import type { ProfileStateWriterInitialization } from './writer/profile-state-writer-protocol'
import {
  closeIndeterminateProfileStateWriter,
  createProfileStateWriter
} from './writer/profile-state-writer-failure-recovery'
import {
  closeIdleProfileStateWriter,
  ProfileStateIdleWriterStop
} from './writer/profile-state-idle-writer-stop'
import {
  ProfileStateWriterReopenPolicy,
  reportTerminalReopenFailure
} from './writer/profile-state-writer-reopen-policy'

export type ProfileStateWorkerAuthorityOptions = {
  workerPath?: string
  backupWorkerPath?: string
  onFailure?: (error: Error) => void
  onSaveDelayChanged?: (delayed: boolean) => void
  /** Close the writer thread after this long without a command; the next one reopens it (~22 ms). */
  writerIdleStopMs?: number
}

/** Main owns backup scheduling; the worker owns every live SQL command while it runs. */
export class ProfileStateWorkerAuthority implements AsyncProfileStateAuthority {
  readonly asynchronous = true
  private writer: ProfileStateWriteWorkerClient | null
  private stoppedRevision: number | undefined
  private stopping: Promise<void> | undefined
  private readonly idleStop: ProfileStateIdleWriterStop
  private inFlight = 0
  private readonly reopenPolicy = new ProfileStateWriterReopenPolicy()
  private stoppedFailure: Error | undefined
  private backups: ProfileStateBackupRotation
  private closing: Promise<void> | undefined

  constructor(
    private readonly initialization: ProfileStateWriterInitialization,
    private readonly options: ProfileStateWorkerAuthorityOptions = {}
  ) {
    this.idleStop = new ProfileStateIdleWriterStop({
      delay: () => this.options.writerIdleStopMs,
      getWriter: () => this.writer,
      shouldSchedule: () => Boolean(this.closing || this.inFlight > 0),
      stop: (writer) => this.stopIdleWriter(writer)
    })
    this.writer = this.createWriter(initialization)
    this.backups = this.createBackups()
    this.idleStop.scheduleAfterReady()
  }

  get ready(): Promise<void> {
    return this.writer?.ready ?? Promise.resolve()
  }

  readSerializedState(): never {
    throw new Error('Live profile state requires its admitted startup snapshot')
  }

  assertWritable(): void {
    if (this.writer) {
      this.writer.assertWritable()
    } else if (this.stoppedFailure) {
      throw this.stoppedFailure
    } else if (this.closing) {
      throw closedProfileStateWriterError()
    }
  }

  async abort(): Promise<void> {
    this.idleStop.cancel()
    // Set before waiting so neither this abort's fault nor a retirement under way is recovered by a reopen.
    this.stoppedFailure ??= new ProfileStateWriterError(
      'profile-state-writer-aborted',
      'Profile state writer was aborted',
      'known-failure'
    )
    if (this.stopping) {
      await this.stopping
    }
    if (this.writer) {
      return this.writer.abort()
    }
  }

  assertCurrentRevision(): Promise<void> {
    return this.run((writer) => writer.assertCurrentRevision()).then(() => {})
  }

  writeSerializedDomains(
    ...args: Parameters<AsyncProfileStateAuthority['writeSerializedDomains']>
  ): Promise<void> {
    return this.run((writer) => writer.writeSerializedDomains(...args)).then(() => {})
  }

  writeSerializedAutomationRuns(
    replacements: readonly ProfileStateDomainReplacement[],
    runs: readonly AutomationRun[]
  ): Promise<void> {
    return this.run((writer) => writer.writeSerializedAutomationRuns(replacements, runs)).then(
      () => {}
    )
  }

  writeCompleteSerializedDomains(
    ...args: Parameters<AsyncProfileStateAuthority['writeCompleteSerializedDomains']>
  ): Promise<void> {
    return this.run((writer) => writer.writeCompleteSerializedDomains(...args)).then(() => {})
  }

  writeSerializedState(payload: Buffer): Promise<void> {
    return this.run((writer) => writer.writeSerializedState(payload)).then(() => {})
  }

  writeJsonExport(targetPath: string): Promise<number> {
    return this.run((writer) => writer.writeJsonExport(targetPath))
  }

  writeLatestJsonExport(dataFile: string): Promise<number | undefined> {
    return this.run((writer) => writer.writeLatestJsonExport(dataFile))
  }

  scheduleBackup(): void {
    if (!this.closing) {
      this.backups.schedule()
    }
  }

  drainBackups(cancel = false): Promise<void> {
    if (cancel) {
      // Only final and maintenance flushes cancel backups; their write must not wait out a backoff.
      this.reopenPolicy.bypassBackoffOnce()
      this.backups.stop()
    }
    return this.backups.drain()
  }

  close(options: { refreshLegacyDocuments?: boolean } = {}): Promise<void> {
    this.idleStop.cancel()
    this.writer?.stopAdmission()
    this.closing ??= this.finishClose(options.refreshLegacyDocuments !== false)
    return this.closing
  }

  async pauseForMaintenance(): Promise<ProfileStateMaintenance> {
    this.assertWritable()
    await this.close({ refreshLegacyDocuments: false })
    const writer = this.writer
    const revision = writer ? writer.acknowledgedRevision : this.requireStoppedRevision()
    let consumed = false
    return {
      resume: async () => {
        if (consumed || this.writer !== writer) {
          throw new Error('Profile maintenance resume has already been consumed')
        }
        if (this.stoppedFailure) {
          throw this.stoppedFailure
        }
        consumed = true
        this.writer = this.createWriter({ ...this.initialization, revision }, true)
        this.backups = this.createBackups()
        this.closing = undefined
        this.idleStop.scheduleAfterReady()
        try {
          await this.writer.ready
          this.assertWritable()
          this.reopenPolicy.recordSuccess()
        } catch (error) {
          await this.close({ refreshLegacyDocuments: false })
          throw error
        }
      }
    }
  }

  async quarantineDatabase(quarantineRoot?: string, reason?: string) {
    await this.close({ refreshLegacyDocuments: false })
    return quarantineProfileStateDatabase(
      this.initialization.databasePath,
      this.initialization.profileId,
      quarantineRoot,
      reason
    )
  }

  private async finishClose(refreshLegacyDocuments: boolean): Promise<void> {
    this.backups.stop()
    // A stop already under way owns the writer; let it finish before deciding what is left to close.
    const writerClosed = this.stopping
      ? this.stopping.then(() => this.writer?.close({ refreshLegacyDocuments }))
      : this.writer?.close({ refreshLegacyDocuments })
    const settled = await Promise.allSettled([this.backups.drain(), writerClosed])
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

  private run<T>(command: (writer: ProfileStateWriteWorkerClient) => Promise<T>): Promise<T> {
    this.idleStop.cancel()
    this.inFlight += 1
    const writer = this.writer
    const result = writer && !this.stopping ? command(writer) : this.reopen().then(command)
    return result.finally(() => {
      this.inFlight -= 1
      this.idleStop.schedule()
    })
  }

  private async reopen(): Promise<ProfileStateWriteWorkerClient> {
    await this.stopping
    if (this.writer) {
      await this.writer.ready
      return this.writer
    }
    if (this.stoppedFailure) {
      throw this.stoppedFailure
    }
    if (this.closing) {
      throw closedProfileStateWriterError()
    }
    this.reopenPolicy.admit()
    const writer = this.createWriter(
      { ...this.initialization, revision: this.requireStoppedRevision() },
      false
    )
    this.writer = writer
    this.reopenPolicy.recordAttempt()
    try {
      await writer.ready
    } catch (error) {
      this.forgetFailedReopen(writer, error)
      throw error
    }
    this.reopenPolicy.recordSuccess()
    return writer
  }

  private forgetFailedReopen(writer: ProfileStateWriteWorkerClient, error: unknown): void {
    if (this.writer !== writer) {
      return
    }
    if (!this.reopenPolicy.recordFailure(error)) {
      reportTerminalReopenFailure(this.options.onFailure, this.reopenPolicy.terminalFailure(error))
      return
    }
    this.writer = null
    void writer.abort().catch(() => {})
  }

  private createWriter(
    initialization: ProfileStateWriterInitialization,
    reportInitializationFailure = false
  ): ProfileStateWriteWorkerClient {
    return createProfileStateWriter(
      initialization,
      this.options,
      reportInitializationFailure,
      (writer, error) => this.handleIndeterminateWriterFailure(writer, error)
    )
  }

  private handleIndeterminateWriterFailure(
    writer: ProfileStateWriteWorkerClient,
    error: Error
  ): void {
    const stopping = closeIndeterminateProfileStateWriter(
      writer,
      () => this.writer === writer && !this.stopping && !this.closing && !this.stoppedFailure,
      (revision) => {
        if (this.writer !== writer || this.closing || this.stoppedFailure) {
          return false
        }
        this.writer = null
        this.stoppedRevision = revision
        this.reopenPolicy.recoverFrom(error)
        return true
      },
      () => reportTerminalReopenFailure(this.options.onFailure, error)
    )
    if (stopping) {
      this.stopping = stopping.finally(() => (this.stopping = undefined))
    }
  }

  private stopIdleWriter(writer: ProfileStateWriteWorkerClient): void {
    const stopping = closeIdleProfileStateWriter(
      writer,
      () => this.writer === writer && !this.closing && this.inFlight === 0 && !this.stopping,
      (revision) => {
        if (this.writer === writer) {
          this.writer = null
          this.stoppedRevision = revision
        }
      }
    )
    if (stopping) {
      this.stopping = stopping.finally(() => (this.stopping = undefined))
    }
  }

  private requireStoppedRevision(): number {
    if (this.stoppedRevision === undefined) {
      throw new Error('Profile state writer stopped without an acknowledged revision')
    }
    return this.stoppedRevision
  }
}
