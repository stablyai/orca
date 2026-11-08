import { JournalGoalAttachmentInverse } from './writing/journal-goal-attachment-inverse'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { readJournalSqlWorkAnswer } from './journal-sql-work-answer'
import { JournalEpochReplacements } from './context-epochs/journal-epoch-replacements'
import { journalWroteBeforeOpen } from './replay/journal-cursor'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalSqlDatabase } from './database/journal-sql-database'
import type { JournalSqlOwner } from './journal-sql-owner'
import type { JournalWriterCommit } from './journal-writer-changes'
import type { JournalWriterOperation, JournalWriterTarget } from './journal-writer-command'
import type { JournalWriterHostFacts } from './journal-writer-host-facts'
import { journalSqlReads, type JournalSqlReads } from './journal-sql-reads'
import type {
  JournalOperationReceipt,
  JournalReceiptStage,
  JournalStagedReceipt
} from './writing/journal-row-writer'
import { AgentSessionJournalError } from './writing/journal-write-guards'
import { SqlJournalQueuedMessages, type JournalSqlQueueWrite } from './journal-sql-queued-messages'
import { SqlJournalReopenMarks } from './journal-sql-reopen-marks'
import { SqlJournalStopMarks } from './journal-sql-stop-marks'
import { SqlJournalAppends } from './journal-sql-appends'
import type { JournalCurrentWorkAuthority } from './journal-observer-read'
import type { JournalWorkRead, JournalWorkAnswer } from './journal-work-read'
import type { JournalDomainHistoryRequest } from './journal-domain-history-page'
import type { JournalDomainEditLeaseOutcome } from './journal-domain-edit-leases'

/** Every writer command a live handle sends; the open command belongs to the database. */
export type JournalSqlStoreOperation = Exclude<JournalWriterOperation, { kind: 'open' }>

export type JournalSqlStorePreparation = {
  facts?: Omit<JournalWriterHostFacts, 'identity'>
  receipt?: JournalOperationReceipt
  /** Adopt host facts staged by prepare only after the writer acknowledges their commit. */
  settle?: (commit: JournalWriterCommit | undefined) => void
}

/** Capture host facts once before admission; adopt staged state only after acknowledgement. */
export type JournalSqlStorePrepare = (
  context: JournalReceiptStage
) => JournalSqlStorePreparation | Promise<JournalSqlStorePreparation>

/** A live ownership token and worker ports; no reduced chat or writable connection lives here. */
export class SqlAgentSessionJournal extends SqlJournalAppends {
  private readonly goalAttachments: JournalGoalAttachmentInverse
  readonly reads: JournalSqlReads
  readonly stopMarks: SqlJournalStopMarks
  readonly queuedMessages: SqlJournalQueuedMessages
  private readonly reopenMarks = new SqlJournalReopenMarks()
  private readonly openedThrough: AgentJournalCursor
  private acknowledged: AgentJournalCursor
  private closed = false
  private closing: Promise<void> | undefined
  private admitted: Promise<unknown> = Promise.resolve()
  private listener: ((commit: JournalWriterCommit) => void) | undefined
  readonly epochReplacements = new JournalEpochReplacements()

  private constructor(
    private readonly database: JournalSqlDatabase,
    readonly identity: AgentSessionJournalIdentity,
    private target: JournalWriterTarget,
    private readonly now: () => number,
    opened: JournalWriterCommit
  ) {
    super()
    this.goalAttachments = new JournalGoalAttachmentInverse(identity.sessionId)
    this.reads = journalSqlReads(database.readers, identity.sessionId)
    this.stopMarks = new SqlJournalStopMarks(this.reads, (run) => this.readInOrder(run))
    this.queuedMessages = new SqlJournalQueuedMessages(
      {
        read: (operation) => this.reads.queue(operation),
        write: async (operation: JournalSqlQueueWrite, receipt) =>
          (await this.write(operation, receipt && (() => ({ receipt })))).value,
        edit: (operation) =>
          this.answerOf<JournalDomainEditLeaseOutcome>(
            this.write({ kind: 'edit-lease', operation })
          )
      },
      this.reopenFloor,
      now
    )
    // The open operation returns its physical position before ordinary recovery.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the open command returns the physical cursor captured before recovery.
    this.openedThrough = { ...(opened.value as AgentJournalCursor) }
    this.acknowledged = { ...opened.cursor }
  }

  static async open(options: {
    database: JournalSqlDatabase
    identity: AgentSessionJournalIdentity
    now?: () => number
  }): Promise<SqlAgentSessionJournal> {
    const { target, commit } = await options.database.openSession(options.identity)
    const journal = new SqlAgentSessionJournal(
      options.database,
      options.identity,
      target,
      options.now ?? Date.now,
      commit
    )
    await journal.queuedMessages.editLeases.expire()
    return journal
  }

  /** The immutable physical position this handle opened at; never the reopen floor. */
  openingCursor = (): AgentJournalCursor => ({ ...this.openedThrough })
  /** Fallback reopen boundary until this handle's mark commits; usually null. */
  reopenFloor = (): AgentJournalCursor | null => this.reopenMarks.floor()
  cursor = (): AgentJournalCursor => ({ ...this.acknowledged })
  physicalCursor = (): AgentJournalCursor => ({
    epoch: this.target.epoch,
    sequence: this.acknowledged.sequence
  })
  observationHandle = (): string => this.target.ownerToken
  get isClosed(): boolean {
    return this.closed
  }
  wroteBeforeOpen(sequence: number | undefined): boolean {
    return journalWroteBeforeOpen(this.physicalCursor(), this.openedThrough, sequence)
  }

  /** Nonthrowing publication runs on the command lane, after receipts have adopted COMMIT. */
  observeCommits(listener: (commit: JournalWriterCommit) => void): () => void {
    const registered: typeof listener = (commit) => listener(commit)
    this.listener = registered
    return () => {
      if (this.listener === registered) {
        this.listener = undefined
      }
    }
  }

  write(
    operation: JournalSqlStoreOperation,
    prepare?: JournalSqlStorePrepare
  ): Promise<JournalWriterCommit> {
    const written = this.admit(async (writer) => {
      const savedAt = this.now()
      const context: JournalReceiptStage = { savedAt, row: receiptRow(operation) }
      const mail =
        operation.kind === 'submission' && operation.consume?.yieldsToPause
          ? await this.queuedMessages.automaticMailFacts(operation.consume.steer)
          : undefined
      const preparation = (await prepare?.(context)) ?? {}
      const facts: JournalWriterHostFacts = {
        identity: this.identity,
        openedThrough: this.openedThrough,
        goals: this.goalAttachments.snapshot(),
        ...this.queuedMessages.facts(mail),
        ...settled(this.stopMarks.fact()),
        ...preparation.facts
      }
      let staged: JournalStagedReceipt | undefined
      let commit: JournalWriterCommit
      try {
        if (preparation.receipt) {
          if (!preparation.receipt.stage) {
            throw new Error('a SQL journal receipt requires worker staging')
          }
          staged = await preparation.receipt.stage(context)
        }
        commit = await writer.write({
          target: this.target,
          operation,
          facts,
          savedAt,
          ...(staged ? { effects: staged.effects } : {})
        })
      } catch (error) {
        preparation.settle?.(undefined)
        staged?.settle(undefined)
        throw error
      }
      preparation.settle?.(commit)
      staged?.settle(commit.receiptWritten ? commit.effects : undefined)
      if (operation.kind === 'epoch-replace') {
        // Public context identities need not equal the physical epoch a command targets.
        const epoch = await this.database.sessionEpoch(this.identity.sessionId)
        if (epoch === null) {
          throw new Error('a committed journal replacement has no physical epoch')
        }
        this.target = { ...this.target, epoch }
      }
      if (commit.goals) {
        this.goalAttachments.adopt(commit.goals)
      }
      this.acknowledged = { ...commit.cursor }
      if (commit.publication?.editDeadline !== undefined) {
        this.queuedMessages.editLeases.adoptDeadline(commit.publication.editDeadline)
      } else if (operation.kind === 'epoch-replace') {
        this.queuedMessages.editLeases.adoptDeadline(null)
      }
      this.listener?.(commit)
      return commit
    })
    return this.epochReplacements.notifyFor(operation.kind, written)
  }

  keepGoalAttachments(identity: AgentJournalItemIdentity): Promise<void> {
    return this.readInOrder(() => this.goalAttachments.keep(agentJournalItemKey(identity)))
  }

  /** Mark preexisting cards; failed writes retain a conservative reopenFloor and throw. */
  markQueueReopen(fence: number, since?: number): Promise<void> {
    return this.reopenMarks.mark(
      async () => {
        const answer = await this.readInOrder((reads) =>
          reads.queue({ kind: 'reopen-mark', facts: this.queuedMessages.facts() })
        )
        if (answer.kind !== 'reopen-mark') {
          throw new Error(`journal queue reader answered ${answer.kind} for reopen-mark`)
        }
        return { awaits: answer.awaits, epoch: this.target.epoch, since: answer.since }
      },
      () =>
        this.answerOf<number | null>(
          this.write({
            kind: 'queue-reopen-mark',
            fence,
            ...(since !== undefined ? { since } : {})
          })
        ),
      since
    )
  }

  /** Pure readers can join preceding commands without allowing another command between reads. */
  readInOrder<T>(read: (reads: JournalSqlReads) => T | Promise<T>): Promise<T> {
    return this.admit(() => read(this.reads))
  }

  history(request: Omit<JournalDomainHistoryRequest, 'sessionId'>) {
    return this.database.readers.domainHistory({ ...request, sessionId: this.identity.sessionId })
  }

  readWork<K extends JournalWorkRead['kind']>(
    capture: () => JournalCurrentWorkAuthority,
    operation: Extract<JournalWorkRead, { kind: K }>
  ): Promise<JournalWorkAnswer<K>> {
    return readJournalSqlWorkAnswer(this, capture, operation)
  }

  /** Refuse admission now; already admitted work retains its ownership until it drains. */
  close(): Promise<void> {
    if (this.closing) {
      return this.closing
    }
    this.queuedMessages.editLeases.dispose()
    const released = this.write({ kind: 'edit-lease', operation: { kind: 'release-owner' } })
    this.closed = true
    this.closing = released.then(() => undefined)
    return this.closing
  }

  private admit<T>(
    run: (writer: Pick<JournalSqlOwner, 'write' | 'effects'>) => T | Promise<T>
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new AgentSessionJournalError(
          'journal_closed',
          `the journal for ${this.identity.sessionId} is closed`
        )
      )
    }
    const result = this.database.serialize(this.identity.sessionId, run)
    this.admitted = result.catch(() => {})
    return result
  }
}

function settled(stopSettle: JournalWriterHostFacts['stopSettle']) {
  return stopSettle ? { stopSettle } : {}
}

function receiptRow(operation: JournalSqlStoreOperation): JournalReceiptStage['row'] {
  switch (operation.kind) {
    case 'item':
    case 'item-claiming':
    case 'prompt-mutate':
      return 'item'
    case 'tombstone':
    case 'goal-withdraw':
    case 'stop':
    case 'stop-accept':
    case 'queue-resume':
    case 'queue-reopen':
    case 'queue-reopen-mark':
      return 'tombstone'
    case 'queue-insert':
    case 'queue-update':
    case 'queue-hold':
    case 'queue-withdraw':
    case 'queue-move':
      return 'queue'
    case 'dispatch':
      return 'dispatch'
    case 'submission':
      return 'submission'
    default:
      return undefined
  }
}
