// One native writer per profile; host mutation ownership includes mandatory postcommit effects.

import { join } from 'node:path'
import { JournalSqlOwner, type JournalReadConnection } from './journal-sql-owner'
import { JournalPersistencePlan } from './journal-persistence-plan'
import { JournalNativeService } from './journal-native-service'
import { JournalReaders, type JournalReadLease } from './journal-readers'
import { journalUnitPackets } from './journal-unit-transfer'
import { restoreJournalSqlFailure } from './journal-sql-protocol'
import { AgentSessionJournalError } from './journal-write-guards'
import type { JournalMaintenanceUnit } from './journal-maintenance-unit'

const JOURNAL_DATABASE_FILE = 'agent-session-journal.db'

export function journalDatabasePath(stateDirectory: string): string {
  return join(stateDirectory, JOURNAL_DATABASE_FILE)
}

export class JournalCommittedEffectError extends Error {
  readonly outcome = 'committed'
}

export class JournalHostDatabase {
  private readonly service = new JournalNativeService()
  private readonly readers: JournalReaders
  private readonly preparationReaders: JournalReaders
  private failure: Error | undefined
  private closed = false
  private closing: Promise<void> | undefined
  readonly faultListeners = new Set<(error: Error) => void>()
  transactionNumber = 0

  private constructor(
    private readonly owner: JournalSqlOwner,
    readonly stateDirectory: string,
    readonly readOnly: boolean
  ) {
    // One of the four native readers stays available to foreground preparation.
    this.readers = new JournalReaders(journalDatabasePath(stateDirectory), 3)
    this.preparationReaders = new JournalReaders(journalDatabasePath(stateDirectory), 1)
    owner.onFault = (error) => {
      this.failure = error
      for (const listener of this.faultListeners) {
        try {
          listener(error)
        } catch (cause) {
          this.report(cause)
        }
      }
    }
  }

  static async open(stateDirectory: string): Promise<JournalHostDatabase> {
    const owner = new JournalSqlOwner(journalDatabasePath(stateDirectory))
    try {
      return new JournalHostDatabase(owner, stateDirectory, await owner.opened())
    } catch (error) {
      await owner.close()
      throw error
    }
  }

  static async holdsSessions(stateDirectory: string): Promise<boolean> {
    const reader = new JournalSqlOwner(journalDatabasePath(stateDirectory), { reader: true })
    try {
      await reader.opened()
      return await reader.connection.probe()
    } finally {
      await reader.close()
    }
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

  /** Prime native WAL state and materialize request values before another publication can run. */
  async snapshot<T>(view: () => T): Promise<JournalReadLease & { view: T }> {
    if (this.isClosed) {
      throw this.closedError()
    }
    const lease = await this.readers.acquire(false)
    try {
      return await this.service.admit(async () => {
        await lease.prime()
        return { ...lease, view: view() }
      })
    } catch (error) {
      await lease.close()
      throw error
    }
  }

  /** Metadata discovery owns only an independent, finite read snapshot. */
  async scan<T>(run: (read: JournalReadConnection) => T | Promise<T>): Promise<T> {
    if (this.isClosed) {
      throw this.closedError()
    }
    const lease = await this.readers.acquire()
    try {
      return await run(lease.read)
    } finally {
      await lease.close()
    }
  }

  async read<T>(run: (read: JournalReadConnection) => T | Promise<T>): Promise<T> {
    const lease = await this.snapshot(() => undefined)
    try {
      return await run(lease.read)
    } finally {
      await lease.close()
    }
  }

  transaction<T>(
    prepare: (plan: JournalPersistencePlan) => T | Promise<T>,
    streamed: boolean | (() => boolean) = false,
    committed?: (result: T) => void | Promise<void>
  ): Promise<T> {
    if (this.isClosed) {
      return Promise.reject(this.closedError())
    }
    return this.service.admit(async () => {
      this.transactionNumber += 1
      const lease = await this.preparationReaders.acquire()
      const plan = new JournalPersistencePlan(lease.read)
      let result: T
      try {
        result = await prepare(plan)
      } finally {
        await lease.close()
      }
      if (plan.effects.length === 0) {
        await committed?.(result)
        return result
      }
      await this.owner.request({ type: 'discard' })
      for (const packet of journalUnitPackets(plan.effects)) {
        await this.owner.request({ type: 'upload', packet })
      }
      const reply = await this.owner.request({
        type: 'unit',
        normal: typeof streamed === 'function' ? streamed() : streamed,
        count: plan.effects.length
      })
      if (reply.type !== 'committed') {
        throw new Error('journal owner did not acknowledge COMMIT')
      }
      const failures: unknown[] = []
      try {
        plan.settle(reply.values)
      } catch (error) {
        failures.push(error)
      }
      try {
        await committed?.(result)
      } catch (error) {
        failures.push(error)
      }
      if (reply.postcommit) {
        this.report(restoreJournalSqlFailure(reply.postcommit))
      }
      if (failures.length) {
        throw new JournalCommittedEffectError('journal committed but mandatory effects failed', {
          cause: new AggregateError(failures, 'mandatory journal commit effects failed')
        })
      }
      return result
    })
  }

  maintenance(
    unit: JournalMaintenanceUnit
  ): Promise<{ more: boolean; valid: boolean; elapsed: number }> {
    if (this.isClosed) {
      return Promise.reject(this.closedError())
    }
    return this.service.admit(async () => {
      const reply = await this.owner.request({ type: 'maintenance', unit })
      if (reply.type !== 'maintained') {
        throw new Error('journal maintenance acknowledgement is missing')
      }
      if (reply.postcommit) {
        this.report(restoreJournalSqlFailure(reply.postcommit))
      }
      return reply
    }, true)
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
    await this.readers.close()
    await this.preparationReaders.close()
    await this.owner.close()
    this.closed = true
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
