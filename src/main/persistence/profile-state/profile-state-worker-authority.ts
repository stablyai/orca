import type { JournalPersistenceEffect } from '../../native-chat/agent-session-journal/journal-persistence-plan'
import type { SurfaceJointTransaction } from '../../workspace-surfaces/surface-joint-transaction'
import { profileStateMaintenance } from './profile-state-maintenance'
import {
  closeIdleProfileStateWriter,
  requireStoppedProfileRevision,
  finishProfileStateWriterClose,
  ProfileStateWriterIdleStop
} from './profile-state-writer-idle-stop'
import type { AutomationRun } from '../../../shared/automations-types'
import type {
  SurfaceStorageCommand,
  SurfaceStorageMutation,
  SurfaceStorageResult
} from '../../../shared/workspace-surfaces/surface-storage-command'
import type {
  AsyncProfileStateAuthority,
  ProfileStateDomainReplacement,
  ProfileStateMaintenance
} from '../loading-store/profile-state-authority'
import {
  createProfileStateWorkerBackupRotation,
  type ProfileStateBackupRotation
} from './profile-state-backup-rotation'
import { quarantineProfileStateDatabase } from './profile-state-database-quarantine'
import {
  ProfileStateWriteWorkerClient,
  ProfileStateWriterError,
  type ProfileStateWriterInitialization
} from './profile-state-writer-worker-client'
import {
  ProfileStateWriterReopenPolicy,
  reportTerminalReopenFailure
} from './profile-state-writer-reopen-policy'
import { closedProfileStateWriterError } from './profile-state-writer-errors'

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
  /** Null while idle-stopped: nothing is pending and `stoppedRevision` is what it acknowledged last. */
  private writer: ProfileStateWriteWorkerClient | null
  private stoppedRevision: number | undefined
  private stopping: Promise<void> | undefined
  private readonly idleStop: ProfileStateWriterIdleStop
  private inFlight = 0
  private readonly reopenPolicy = new ProfileStateWriterReopenPolicy()
  /** Abort while idle-stopped has no writer to fault, so it is remembered here instead. */
  private stoppedFailure: Error | undefined
  private backups: ProfileStateBackupRotation
  private closing: Promise<void> | undefined

  constructor(
    private readonly initialization: ProfileStateWriterInitialization,
    private readonly options: ProfileStateWorkerAuthorityOptions = {}
  ) {
    this.idleStop = new ProfileStateWriterIdleStop(options.writerIdleStopMs, () =>
      this.stopIdleWriter()
    )
    this.writer = new ProfileStateWriteWorkerClient(initialization, options)
    this.backups = this.createBackups()
    this.scheduleIdleStopAfterReady()
  }

  get surfaceExecutionScope() {
    this.assertWritable()
    return {
      databasePath: this.initialization.databasePath,
      profileId: this.initialization.profileId
    }
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
    if (this.stopping) {
      await this.stopping
    }
    if (this.writer) {
      return this.writer.abort()
    }
    this.stoppedFailure ??= new ProfileStateWriterError(
      'profile-state-writer-aborted',
      'Profile state writer was aborted',
      'known-failure'
    )
  }

  async assertCurrentRevision(): Promise<void> {
    await this.run((writer) => writer.assertCurrentRevision())
  }

  executeSurfaceCommand(command: SurfaceStorageCommand): Promise<SurfaceStorageResult> {
    return this.run((writer) => writer.executeSurfaceCommand(command))
  }

  executeSurfaceTransaction(
    commands: readonly SurfaceStorageMutation[]
  ): Promise<SurfaceStorageResult[]> {
    return this.run((writer) => writer.executeSurfaceTransaction(commands))
  }

  executeSurfaceJointTransaction(
    transaction: SurfaceJointTransaction
  ): Promise<SurfaceStorageResult[]> {
    return this.run((writer) => writer.executeSurfaceJointTransaction(transaction))
  }

  executeSurfaceJournalUnit(
    transaction: SurfaceJointTransaction,
    effects: readonly JournalPersistenceEffect[]
  ) {
    return this.run((writer) => writer.executeSurfaceJournalUnit(transaction, effects))
  }

  async writeSerializedDomains(
    replacements: readonly ProfileStateDomainReplacement[]
  ): Promise<void> {
    await this.run((writer) => writer.writeSerializedDomains(replacements))
  }

  async writeSerializedAutomationRuns(
    replacements: readonly ProfileStateDomainReplacement[],
    runs: readonly AutomationRun[]
  ): Promise<void> {
    await this.run((writer) => writer.writeSerializedAutomationRuns(replacements, runs))
  }

  async writeCompleteSerializedDomains(
    replacements: readonly ProfileStateDomainReplacement[]
  ): Promise<void> {
    await this.run((writer) => writer.writeCompleteSerializedDomains(replacements))
  }

  async writeSerializedState(payload: Buffer): Promise<void> {
    await this.run((writer) => writer.writeSerializedState(payload))
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

  close(): Promise<void> {
    this.idleStop.cancel()
    this.writer?.stopAdmission()
    this.closing ??= this.finishClose()
    return this.closing
  }

  async pauseForMaintenance(): Promise<ProfileStateMaintenance> {
    this.assertWritable()
    await this.close()
    const writer = this.writer
    const revision = writer
      ? writer.acknowledgedRevision
      : requireStoppedProfileRevision(this.stoppedRevision)
    return profileStateMaintenance(async () => {
      if (this.writer !== writer) {
        throw new Error('Profile maintenance owner changed before resume')
      }
      this.writer = new ProfileStateWriteWorkerClient(
        { ...this.initialization, revision },
        { ...this.options, reportInitializationFailure: true }
      )
      this.backups = this.createBackups()
      this.closing = undefined
      this.scheduleIdleStopAfterReady()
      try {
        await this.writer.ready
        this.assertWritable()
      } catch (error) {
        await this.close()
        throw error
      }
    })
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
    await finishProfileStateWriterClose(this.backups, this.stopping, () => this.writer)
  }

  private createBackups(): ProfileStateBackupRotation {
    const { databasePath, profileId } = this.initialization
    return createProfileStateWorkerBackupRotation(
      databasePath,
      profileId,
      this.options.backupWorkerPath
    )
  }

  private run<T>(command: (writer: ProfileStateWriteWorkerClient) => Promise<T>): Promise<T> {
    this.idleStop.cancel()
    this.inFlight += 1
    const writer = this.writer
    const result = writer && !this.stopping ? command(writer) : this.reopen().then(command)
    return result.finally(() => {
      this.inFlight -= 1
      this.scheduleIdleStop()
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
    const writer = new ProfileStateWriteWorkerClient(
      { ...this.initialization, revision: requireStoppedProfileRevision(this.stoppedRevision) },
      // A retriable failure is not "saving has stopped"; forgetFailedReopen reports only terminal ones.
      { ...this.options, reportInitializationFailure: false }
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

  /** A spawn or open failure must not wedge saving: go back to stopped so a later command retries. */
  private forgetFailedReopen(writer: ProfileStateWriteWorkerClient, error: unknown): void {
    if (this.writer !== writer) {
      return
    }
    const retry = this.reopenPolicy.recordFailure(error)
    if (!retry) {
      reportTerminalReopenFailure(this.options.onFailure, error)
      return
    }
    this.writer = null
    void writer.abort().catch(() => {})
  }

  get writerIdleStopPending(): boolean {
    return this.idleStop.pending
  }

  private scheduleIdleStopAfterReady(): void {
    void this.writer?.ready.then(
      () => this.scheduleIdleStop(),
      () => {}
    )
  }

  private scheduleIdleStop(): void {
    if (!this.closing && this.inFlight === 0 && this.writer) {
      this.idleStop.schedule()
    }
  }

  private stopIdleWriter(): void {
    const writer = this.writer
    if (!writer || this.closing || this.inFlight > 0 || this.stopping) {
      return
    }
    this.stopping = closeIdleProfileStateWriter(
      writer,
      (revision) => {
        if (this.writer === writer) {
          this.writer = null
          this.stoppedRevision = revision
        }
      },
      () => {
        this.stopping = undefined
      }
    )
  }

  get writerReopenCount(): number {
    return this.reopenPolicy.count
  }
}
