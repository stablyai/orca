import { journalDatabaseHoldsSessions } from './journal-database-session-probe'
import type { SurfaceJointResult } from '../../workspace-surfaces/surface-joint-transaction'
import type { SurfaceStorageMutation } from '../../../shared/workspace-surfaces/surface-storage-command'
import type { JournalMaintenanceUnit, JournalMaintenanceResult } from './journal-maintenance-unit'
// One native writer per profile; host mutation ownership includes mandatory postcommit effects.

import { join } from 'node:path'
import { JournalIndeterminateWriteError, type JournalReadConnection } from './journal-sql-owner'
import { JournalPersistencePlan } from './journal-persistence-plan'
import { JournalNativeService } from './journal-native-service'
import type { JournalReadLease } from './journal-readers'
import { JournalNativeStorage } from './journal-native-storage'
import { adoptJournalCommittedEffects, settleJournalCommitAsync } from './journal-committed-effects'
import { profileStateWriterFailureOutcome } from '../../persistence/profile-state/profile-state-writer-errors'
import { journalTransferBatches, journalUnitPackets } from './journal-unit-transfer'
import { restoreJournalSqlFailure } from './journal-sql-protocol'
import { AgentSessionJournalError } from './journal-write-guards'

const JOURNAL_DATABASE_FILE = 'agent-session-journal.db'

export function journalDatabasePath(stateDirectory: string): string {
  return join(stateDirectory, JOURNAL_DATABASE_FILE)
}

export { JournalCommittedEffectError } from './journal-committed-effects'

export class JournalHostDatabase {
  private readonly service = new JournalNativeService()
  private failure: Error | undefined
  private closed = false
  private closing: Promise<void> | undefined
  readonly faultListeners = new Set<(error: Error) => void>()
  surfaceOwner:
    | ((
        plan: JournalPersistencePlan,
        journalPath: string,
        committed: (result: SurfaceJointResult, publish: () => void) => Promise<void>
      ) => Promise<SurfaceJointResult>)
    | undefined
  surfaceCommands:
    | ((
        commands: readonly SurfaceStorageMutation[],
        committed: (result: SurfaceJointResult) => void | Promise<void>,
        admit?: () => void,
        afterCommitted?: (result: SurfaceJointResult) => void
      ) => Promise<SurfaceJointResult>)
    | undefined
  private notifications: (() => void)[] | undefined
  transactionNumber = 0

  private constructor(
    private readonly storage: JournalNativeStorage,
    readonly stateDirectory: string
  ) {
    storage.onFault = (error) => this.fault(error)
  }

  static async open(stateDirectory: string, workerPath?: string): Promise<JournalHostDatabase> {
    return new JournalHostDatabase(
      await JournalNativeStorage.open(journalDatabasePath(stateDirectory), workerPath),
      stateDirectory
    )
  }

  get readOnly(): boolean {
    return this.storage.readOnly
  }

  static async holdsSessions(stateDirectory: string): Promise<boolean> {
    return journalDatabaseHoldsSessions(journalDatabasePath(stateDirectory))
  }

  get isClosed(): boolean {
    return this.closed || this.closing !== undefined || this.failure !== undefined
  }

  get hasClosed(): boolean {
    return this.closed
  }

  get isFaulted(): boolean {
    return this.failure !== undefined
  }

  /** Acquire and prime behind native admission so queued readers cannot hold up a preceding drain. */
  snapshot<T>(view: () => T): Promise<JournalReadLease & { view: T }> {
    return this.admit(async () => {
      const lease = await this.storage.snapshot()
      try {
        return { ...lease, view: view() }
      } catch (error) {
        await lease.close()
        throw error
      }
    })
  }

  async scan<T>(run: (read: JournalReadConnection) => T | Promise<T>): Promise<T> {
    const lease = await this.snapshot(() => undefined)
    try {
      return await run(lease.read)
    } finally {
      await lease.close()
    }
  }

  read<T>(run: (read: JournalReadConnection) => T | Promise<T>): Promise<T> {
    return this.scan(run)
  }

  transaction<T>(
    prepare: (plan: JournalPersistencePlan) => T | Promise<T>,
    streamed: boolean | (() => boolean) = false,
    committed?: (result: T) => void | Promise<void>
  ): Promise<T> {
    return this.admit(async () => {
      this.transactionNumber += 1
      const lease = await this.storage.snapshot(true)
      const plan = new JournalPersistencePlan(lease.read)
      let result: T
      try {
        result = await prepare(plan)
      } finally {
        await lease.close()
      }
      if (plan.effects.length === 0 && plan.memberships.length === 0) {
        await committed?.(result)
        return result
      }
      if (this.surfaceOwner && plan.memberships.length) {
        const owner = this.surfaceOwner
        await this.jointAdmitted<SurfaceJointResult>(
          (path, settle) => owner(plan, path, settle),
          async (joint) => {
            const host = joint.surfaces.at(-1)?.host
            const tabs =
              host?.nativeTabs ??
              host?.surfaces.flatMap((surface) =>
                surface.content?.kind === 'agent-session'
                  ? [{ tabId: surface.hostTabId, sessionId: surface.content.sessionId }]
                  : []
              ) ??
              []
            await settleJournalCommitAsync([
              ...plan.memberships.map((change) => () => change.adopt(tabs)),
              () => plan.settle(joint.values),
              () => committed?.(result)
            ])
          }
        )
        return result
      }
      await this.storage.writer.request({ type: 'discard' })
      for (const packets of journalTransferBatches(journalUnitPackets(plan.effects))) {
        await this.storage.writer.request({ type: 'upload', packets })
      }
      const reply = await this.storage.writer.request({
        type: 'unit',
        normal: typeof streamed === 'function' ? streamed() : streamed,
        count: plan.effects.length
      })
      if (reply.type !== 'committed') {
        throw new Error('journal owner did not acknowledge COMMIT')
      }
      if (reply.postcommit) {
        this.report(restoreJournalSqlFailure(reply.postcommit))
      }
      await this.adopt([() => plan.settle(reply.values), () => committed?.(result)])
      return result
    })
  }

  maintenance(unit: JournalMaintenanceUnit): Promise<JournalMaintenanceResult> {
    return this.admit(async () => {
      const reply = await this.storage.writer.request({ type: 'maintenance', unit })
      if (reply.type !== 'maintained') {
        throw new Error('Native maintenance result is missing')
      }
      if (reply.postcommit) {
        this.report(restoreJournalSqlFailure(reply.postcommit))
      }
      return reply
    }, true)
  }

  /** The profile owner commits and detaches its attached job while this same native lane stays held. */
  joint<T>(
    write: (journalPath: string) => Promise<T>,
    committed: (result: T) => void | Promise<void>
  ): Promise<T> {
    return this.jointPrepared(async (path, settle) => {
      const result = await write(path)
      await settle(result, () => {})
      return result
    }, committed)
  }

  /** Keep profile admission held until native reopen and both mirrors have adopted. */
  jointPrepared<T>(
    write: (
      journalPath: string,
      committed: (result: T, publish: () => void) => Promise<void>
    ) => Promise<T>,
    committed: (result: T) => void | Promise<void>
  ): Promise<T> {
    return this.admit(() => this.jointAdmitted(write, committed))
  }

  private async jointAdmitted<T>(
    write: (
      journalPath: string,
      committed: (result: T, publish: () => void) => Promise<void>
    ) => Promise<T>,
    committed: (result: T) => void | Promise<void>
  ): Promise<T> {
    if (this.readOnly) {
      throw new AgentSessionJournalError('journal_read_only', 'The chat journal is read only')
    }
    try {
      await this.storage.close()
    } catch (error) {
      this.fault(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
    let committedStorage = false
    try {
      return await write(this.storage.filename, async (result, publish) => {
        committedStorage = true
        await this.adopt([() => this.storage.reopen(), () => committed(result), publish])
      })
    } catch (error) {
      if (committedStorage) {
        throw error
      }
      if (profileStateWriterFailureOutcome(error) === 'indeterminate') {
        this.fault(error instanceof Error ? error : new Error(String(error)))
        throw error
      }
      try {
        await this.storage.reopen()
      } catch (reopen) {
        this.fault(reopen instanceof Error ? reopen : new Error(String(reopen)))
        throw new AggregateError(
          [error, reopen],
          'Native journal failed to reopen after rejected joint work'
        )
      }
      throw error
    }
  }

  close(): Promise<void> {
    this.closing ??= this.finishClose().catch((error: unknown) => {
      this.closing = undefined
      throw error
    })
    return this.closing
  }

  private async finishClose(): Promise<void> {
    if (this.closed) {
      return
    }
    await this.service.close()
    await this.storage.close()
    this.closed = true
  }

  private admit<T>(run: () => Promise<T>, maintenance = false): Promise<T> {
    if (this.isClosed) {
      return Promise.reject(this.closedError())
    }
    return this.service.admit(async () => {
      if (this.failure) {
        throw this.failure
      }
      try {
        return await run()
      } catch (error) {
        if (error instanceof JournalIndeterminateWriteError) {
          this.fault(error)
        }
        throw error
      }
    }, maintenance)
  }

  /** Delivery follows mandatory state adoption and cannot revoke its readable committed result. */
  notifyCommitted(notify: () => void): void {
    if (this.notifications) {
      this.notifications.push(notify)
    } else {
      notify()
    }
  }

  private async adopt(effects: (() => void | Promise<void>)[]): Promise<void> {
    await adoptJournalCommittedEffects(
      effects,
      (notifications) => {
        this.notifications = notifications
      },
      (failure) => this.fault(failure)
    )
  }

  private fault(error: Error): void {
    this.failure ??= error
    for (const listener of this.faultListeners) {
      try {
        listener(error)
      } catch (cause) {
        this.report(cause)
      }
    }
  }

  private closedError(): Error {
    return (
      this.failure ??
      new AgentSessionJournalError('journal_closed', 'the chat journal database is closed')
    )
  }

  private report(error: unknown): void {
    try {
      console.warn('[agent-session-journal] postcommit settings failed', error)
    } catch {
      // Diagnostics never revoke known COMMIT.
    }
  }
}
