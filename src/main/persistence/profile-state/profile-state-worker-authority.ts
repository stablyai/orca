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
  ProfileStateWriterError,
  type ProfileStateWriterInitialization
} from './profile-state-writer-worker-client'
import {
  ProfileStateWriterReopenPolicy,
  reportTerminalReopenFailure
} from './profile-state-writer-reopen-policy'

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
  private idleTimer: ReturnType<typeof setTimeout> | undefined
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
    this.writer = new ProfileStateWriteWorkerClient(initialization, options)
    this.backups = this.createBackups()
    this.scheduleIdleStopAfterReady()
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
      throw closedWriterError()
    }
  }

  async abort(): Promise<void> {
    this.cancelIdleStop()
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

  assertCurrentRevision(): Promise<void> {
    return this.run((writer) => writer.assertCurrentRevision()).then(() => {})
  }

  writeSerializedDomains(replacements: readonly ProfileStateDomainReplacement[]): Promise<void> {
    return this.run((writer) => writer.writeSerializedDomains(replacements)).then(() => {})
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
    replacements: readonly ProfileStateDomainReplacement[]
  ): Promise<void> {
    return this.run((writer) => writer.writeCompleteSerializedDomains(replacements)).then(() => {})
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

  close(): Promise<void> {
    this.cancelIdleStop()
    this.writer?.stopAdmission()
    this.closing ??= this.finishClose()
    return this.closing
  }

  async pauseForMaintenance(): Promise<ProfileStateMaintenance> {
    this.assertWritable()
    await this.close()
    const writer = this.writer
    const revision = writer ? writer.acknowledgedRevision : this.requireStoppedRevision()
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
        this.scheduleIdleStopAfterReady()
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
    // A stop already under way owns the writer; let it finish before deciding what is left to close.
    const writerClosed = this.stopping
      ? this.stopping.then(() => this.writer?.close())
      : this.writer?.close()
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

  /** A running writer dispatches synchronously, as before; only a stopped one is reopened first. */
  private run<T>(command: (writer: ProfileStateWriteWorkerClient) => Promise<T>): Promise<T> {
    this.cancelIdleStop()
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
      // A concurrent caller already reopened it; dispatch only once it initialized.
      await this.writer.ready
      return this.writer
    }
    if (this.stoppedFailure) {
      throw this.stoppedFailure
    }
    if (this.closing) {
      throw closedWriterError()
    }
    this.reopenPolicy.admit()
    const writer = new ProfileStateWriteWorkerClient(
      { ...this.initialization, revision: this.requireStoppedRevision() },
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
    return this.idleTimer !== undefined
  }

  private scheduleIdleStopAfterReady(): void {
    void this.writer?.ready.then(
      () => this.scheduleIdleStop(),
      () => {}
    )
  }

  private scheduleIdleStop(): void {
    const delay = this.options.writerIdleStopMs
    if (
      delay === undefined ||
      this.idleTimer ||
      this.closing ||
      this.inFlight > 0 ||
      !this.writer
    ) {
      return
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      this.stopIdleWriter()
    }, delay)
    this.idleTimer.unref?.()
  }

  private cancelIdleStop(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private stopIdleWriter(): void {
    const writer = this.writer
    if (!writer || this.closing || this.inFlight > 0 || this.stopping) {
      return
    }
    let revision: number
    try {
      // A faulted writer stays in place so assertWritable keeps reporting its failure.
      writer.assertWritable()
      revision = writer.acknowledgedRevision
    } catch {
      return
    }
    this.stopping = writer
      .close()
      .then(() => {
        if (this.writer === writer) {
          this.writer = null
          this.stoppedRevision = revision
        }
      })
      // The writer's own fault handling reports a failed close; it stays as the faulted writer.
      .catch(() => {})
      .finally(() => {
        this.stopping = undefined
      })
  }

  get writerReopenCount(): number {
    return this.reopenPolicy.count
  }

  private requireStoppedRevision(): number {
    if (this.stoppedRevision === undefined) {
      throw new Error('Profile state writer stopped without an acknowledged revision')
    }
    return this.stoppedRevision
  }
}

function closedWriterError(): ProfileStateWriterError {
  return new ProfileStateWriterError(
    'profile-state-writer-closed',
    'Profile state writer is closing',
    'known-failure'
  )
}
