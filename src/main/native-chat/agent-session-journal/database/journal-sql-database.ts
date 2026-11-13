import { JournalSqlForkCopy } from '../journal-sql-fork-copy'
import type { JournalForkPreparationInput } from '../journal-fork-preparation'
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
import { assertJournalChatReadable } from '../replay/journal-open-failure'
import { journalDatabasePath } from './journal-host-database'
import { journalDomainDatabasePath } from './journal-domain-database'
import type { JournalSqlStoredRecords } from '../journal-sql-database-read'

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
      options.readerPath,
      (cache) => {
        if (!this.readOnly && !this.closed && !this.activity.isSessionActive(cache.sessionId)) {
          void this.writer.maintain({ kind: 'outline-cache', cache }).catch((error: unknown) => {
            if (!this.closed) {
              options.onMaintenanceError(error, cache.sessionId)
            }
          })
        }
      },
      () => assertJournalChatReadable(this.readOnly)
    )
    this.conversions = new JournalSqlConversions(writer, this.readers, this.activity.waitForIdle)
    this.maintenance = new JournalSqlBackgroundMaintenance(
      writer,
      this.readers,
      this.conversions,
      this.activity,
      options.onMaintenanceError
    )
    if (!this.readOnly) {
      this.maintenance.ownLegacySource(stateDirectory, this.readers)
    }
  }

  static async open(
    stateDirectory: string,
    options: {
      writerPath?: string
      readerPath?: string
      onMaintenanceError: (error: unknown, sessionId?: string) => void
    }
  ): Promise<JournalSqlDatabase> {
    const filename = journalDomainDatabasePath(stateDirectory)
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

  /** An invalid acknowledged result cannot become a stale base for another write. */
  fault(error: Error): void {
    this.writer.fault(error)
  }

  /** The installed record-store slot owns maintenance, including before chat-host construction. */
  startMaintenance(): Promise<void> {
    return this.readOnly || this.closed ? Promise.resolve() : this.maintenance.start()
  }

  stopMaintenance(): void {
    this.maintenance.stop()
  }

  holdActivity(): () => void {
    return this.activity.hold()
  }

  setSessionActive(sessionId: string, active: boolean): void {
    this.activity.setSessionActive(sessionId, active)
  }

  requestSweep(): void {
    if (!this.readOnly && !this.closed) {
      void this.maintenance.requestSweep()
    }
  }

  /** Source attachment custody starts before the WAL snapshot and ends with disposable preparation. */
  async prepareForkCopy(
    input: JournalForkPreparationInput,
    signal?: AbortSignal
  ): Promise<JournalSqlForkCopy> {
    this.assertOpen()
    const held = await this.writer.maintain({
      kind: 'fork-source-hold',
      sessionId: input.source.sessionId
    })
    if (!held || typeof held !== 'object' || !('token' in held)) {
      throw new Error('fork source has no attachment custody')
    }
    return JournalSqlForkCopy.capture(
      this.readers,
      input,
      async () => {
        await this.writer.maintain({ kind: 'fork-source-release', token: held.token })
        this.requestSweep()
      },
      () => this.requestSweep(),
      signal
    )
  }

  async loadRecords(): Promise<AgentSessionStoreState> {
    return this.observeRecords(this.readOnly)
  }

  /** One installation transaction owns both invalidation and the rows exposed to this host. */
  async installRecords(): Promise<AgentSessionStoreState> {
    this.assertOpen()
    if (this.readOnly) {
      return this.observeRecords(true)
    }
    try {
      return this.restoreRecordTabs(await this.writer.installRecords())
    } catch {
      // Saved chats remain readable; the writer retries installation before admitting any mutation.
      return this.observeRecords(true)
    }
  }

  private async observeRecords(unreconciled: boolean): Promise<AgentSessionStoreState> {
    this.assertOpen()
    const result = await this.readers.database({
      kind: 'records',
      ...(unreconciled ? { unreconciled: true } : {})
    })
    if (result.kind !== 'records') {
      throw new Error('journal reader returned no records')
    }
    return this.restoreRecordTabs(result.records)
  }

  private restoreRecordTabs(records: JournalSqlStoredRecords): AgentSessionStoreState {
    return {
      ...records,
      sessionTabs:
        records.sessionTabs === null ? null : new AgentSessionTabTable(records.sessionTabs)
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
    return this.readOnly
      ? Promise.resolve(null)
      : this.serialize(sessionId, () => this.conversions.ensure(sessionId))
  }

  openSession(
    identity: AgentSessionJournalIdentity,
    savedAt = Date.now(),
    recover?: { fence: number }
  ) {
    return this.serialize(identity.sessionId, async () => {
      assertJournalChatReadable(this.readOnly)
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
        this.conversions.rememberReady(identity.sessionId, epoch)
      }
      const target = { sessionId: identity.sessionId, epoch, ownerToken: randomUUID() }
      try {
        const commit = await this.writer.write({
          target,
          operation: { kind: 'open', recover },
          savedAt
        })
        return { target, commit }
      } catch (error) {
        if (!this.writer.recordsPending) {
          throw error
        }
      }
      const head = await this.readers.point({
        sessionId: identity.sessionId,
        operation: { kind: 'metadata' }
      })
      if (head.kind !== 'metadata') {
        throw new Error('journal reader returned no opening head')
      }
      const commit: JournalWriterCommit = {
        cursor: head.cursor,
        queueRevision: head.queueRevision,
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
    const release = this.activity.hold()
    return this.writer.effects(effects).finally(release)
  }

  /** Planning and ordered reads share the chat's lane; ordinary readers see the last COMMIT. */
  serialize<T>(
    sessionId: string,
    run: (writer: Pick<JournalSqlOwner, 'write' | 'effects' | 'maintain'>) => T | Promise<T>
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
