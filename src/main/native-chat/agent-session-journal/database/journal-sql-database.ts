import { randomUUID } from 'node:crypto'
import type { AgentSessionJournalIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { AgentSessionTabTable } from '../../../runtime/agent-session/agent-session-tab-table'
import type { AgentSessionStoreState } from '../../../runtime/agent-session/records/agent-session-store-state'
import { JournalSqlOwner } from '../journal-sql-owner'
import { JournalSqlReaderPool } from '../journal-sql-reader-pool'
import { JournalSqlConversions } from '../journal-sql-conversions'
import { JournalSqlActivity } from '../journal-sql-activity'
import { JournalSqlBackgroundMaintenance } from '../journal-sql-background-maintenance'
import type { JournalWriterCommand } from '../journal-writer-command'
import type { JournalWriterCommit } from '../journal-writer-changes'
import type { JournalWriterEffect, JournalWriterEffectResult } from '../journal-writer-effects'
import type { CommandReceiptScope } from '../writing/command-receipt-schema'
import { AgentSessionJournalError } from '../writing/journal-write-guards'
import { journalDatabasePath } from './journal-host-database'
import {
  initializeJournalDomainDatabase,
  journalDomainDatabasePath
} from './journal-domain-database'

/** The runtime owns workers, never a writable connection or a retained chat projection. */
export class JournalSqlDatabase {
  readonly readers: JournalSqlReaderPool
  private readonly conversions: JournalSqlConversions
  private readonly activity = new JournalSqlActivity()
  private readonly maintenance: JournalSqlBackgroundMaintenance
  private readonly sessions = new Map<string, Promise<unknown>>()
  private closing: Promise<void> | undefined
  private closed = false

  private constructor(
    private readonly writer: JournalSqlOwner,
    readonly stateDirectory: string,
    readonly readOnly: boolean,
    options: {
      readerPath?: string
      onMaintenanceError: (error: unknown, sessionId?: string) => void
    }
  ) {
    this.readers = new JournalSqlReaderPool(
      journalDomainDatabasePath(stateDirectory),
      journalDatabasePath(stateDirectory),
      options.readerPath
    )
    this.conversions = new JournalSqlConversions(writer, this.readers, this.activity.waitForIdle)
    this.maintenance = new JournalSqlBackgroundMaintenance(
      writer,
      this.readers,
      this.conversions,
      this.activity,
      options.onMaintenanceError
    )
  }

  static async open(
    stateDirectory: string,
    options: {
      writerPath?: string
      readerPath?: string
      onMaintenanceError: (error: unknown, sessionId?: string) => void
    }
  ): Promise<JournalSqlDatabase> {
    const filename = await initializeJournalDomainDatabase(stateDirectory)
    const writer = new JournalSqlOwner(filename, stateDirectory, options.writerPath)
    try {
      return new JournalSqlDatabase(writer, stateDirectory, await writer.opened(), options)
    } catch (error) {
      await writer.close()
      throw error
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  set onFault(listener: (error: Error) => void) {
    this.writer.onFault = listener
  }

  /** Start after runtime activity has been installed, so startup work never outruns live chats. */
  startMaintenance(): Promise<void> {
    this.assertOpen()
    return this.readOnly ? Promise.resolve() : this.maintenance.start()
  }

  setSessionActive(sessionId: string, active: boolean): void {
    this.activity.setSessionActive(sessionId, active)
  }

  requestSweep(): Promise<void> {
    this.assertOpen()
    return this.readOnly ? Promise.resolve() : this.maintenance.requestSweep()
  }

  async loadRecords(): Promise<AgentSessionStoreState> {
    this.assertOpen()
    const result = await this.readers.database({ kind: 'records' })
    if (result.kind !== 'records') {
      throw new Error('journal reader returned no records')
    }
    return {
      ...result.records,
      sessionTabs:
        result.records.sessionTabs === null
          ? null
          : new AgentSessionTabTable(result.records.sessionTabs)
    }
  }

  async readCommandReceipt(scope: CommandReceiptScope, operationId: string) {
    this.assertOpen()
    const result = await this.readers.database({ kind: 'receipt', scope, operationId })
    if (result.kind !== 'receipt') {
      throw new Error('journal reader returned no receipt')
    }
    return result.receipt
  }

  async sessionEpoch(sessionId: string): Promise<string | null> {
    this.assertOpen()
    return this.readEpoch(sessionId)
  }

  ensureSessionEpoch(sessionId: string): Promise<string | null> {
    return this.serialize(sessionId, () => this.conversions.ensure(sessionId))
  }

  openSession(identity: AgentSessionJournalIdentity) {
    return this.serialize(identity.sessionId, async () => {
      let epoch = await this.conversions.ensure(identity.sessionId)
      if (epoch === null) {
        const founded = await this.writer.maintain({
          kind: 'import-finish',
          header: {
            sessionId: identity.sessionId,
            workspaceId: identity.workspaceId,
            epoch: randomUUID(),
            head: {
              lastSequence: 0,
              highestFence: 0,
              contextBoundary: 0,
              lastActivityAt: 0,
              derivedTurnItemId: null,
              historyOrigin: null,
              queueFailureBoundary: 0,
              queuePauseMarks: { latestStop: null, resumedSequence: 0, reopenedSequence: 0 }
            }
          }
        })
        if (typeof founded !== 'string') {
          throw new Error('founded journal has no physical epoch')
        }
        epoch = founded
      }
      const head = await this.readers.point({
        sessionId: identity.sessionId,
        operation: { kind: 'metadata' }
      })
      if (head.kind !== 'metadata') {
        throw new Error('journal reader returned no opening head')
      }
      const target = { sessionId: identity.sessionId, epoch, ownerToken: randomUUID() }
      const commit: JournalWriterCommit = {
        cursor: head.cursor,
        value: head.physicalCursor,
        inputChanged: false,
        items: [],
        keys: [],
        inputKeys: [],
        effects: []
      }
      return { target, commit }
    })
  }

  write(command: JournalWriterCommand): Promise<JournalWriterCommit> {
    return this.serialize(command.target.sessionId, () => this.writer.write(command))
  }

  effects(effects: readonly JournalWriterEffect[]): Promise<JournalWriterEffectResult[]> {
    this.assertOpen()
    return this.writer.effects(effects)
  }

  /** Planning and ordered reads share the chat's lane; ordinary readers see the last COMMIT. */
  serialize<T>(
    sessionId: string,
    run: (writer: Pick<JournalSqlOwner, 'write' | 'effects'>) => T | Promise<T>
  ): Promise<T> {
    this.assertOpen()
    const release = this.activity.hold()
    const result = (this.sessions.get(sessionId) ?? Promise.resolve()).then(() => run(this.writer))
    const settled = result
      .catch(() => {})
      .finally(() => {
        release()
        if (this.sessions.get(sessionId) === settled) {
          this.sessions.delete(sessionId)
        }
      })
    this.sessions.set(sessionId, settled)
    return result
  }

  close(): Promise<void> {
    this.closing ??= this.finishClose().catch((error: unknown) => {
      this.closing = undefined
      throw error
    })
    return this.closing
  }

  private async readEpoch(sessionId: string): Promise<string | null> {
    const result = await this.readers.database({ kind: 'epoch', sessionId })
    if (result.kind !== 'epoch') {
      throw new Error('journal reader returned no epoch')
    }
    return result.epoch
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AgentSessionJournalError('journal_closed', 'the chat journal database is closed')
    }
  }

  private async finishClose(): Promise<void> {
    this.closed = true
    this.maintenance.stop()
    await Promise.allSettled(this.sessions.values())
    await this.conversions.close()
    await this.maintenance.settled()
    await this.readers.close()
    await this.writer.close()
  }
}
