import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalSqlDatabase } from './database/journal-sql-database'
import type { JournalSqlOwner } from './journal-sql-owner'
import type { JournalWriterCommit } from './journal-writer-changes'
import type { JournalWriterOperation, JournalWriterTarget } from './journal-writer-command'
import {
  JournalHostFactsNeededError,
  type JournalHostFactsNeeded,
  type JournalWriterHostFacts
} from './journal-writer-host-facts'
import { journalSqlReads, type JournalSqlReads } from './journal-sql-reads'
import type {
  JournalOperationReceipt,
  JournalReceiptStage,
  JournalStagedReceipt
} from './writing/journal-row-writer'
import { AgentSessionJournalError } from './writing/journal-write-guards'

/** Queue commands join this surface after their ordered-list owner has landed. */
export type JournalSqlStoreOperation =
  | Extract<
      JournalWriterOperation,
      {
        kind:
          | 'item'
          | 'item-claiming'
          | 'tombstone'
          | 'goal-withdraw'
          | 'dispatch'
          | 'stop'
          | 'context-clear'
          | 'context-rewind'
          | 'epoch-replace'
      }
    >
  | {
      kind: 'lifecycle'
      input: Omit<Extract<JournalWriterOperation, { kind: 'lifecycle' }>['input'], 'rejectsQueued'>
    }
  | {
      kind: 'submission'
      input: Omit<
        Extract<JournalWriterOperation, { kind: 'submission' }>['input'],
        'queuedMessageId'
      >
    }

export type JournalSqlStorePreparation = {
  facts?: Omit<JournalWriterHostFacts, 'identity'>
  receipt?: JournalOperationReceipt
  /** Adopt host facts staged by prepare only after the writer acknowledges their commit. */
  settle?: (commit: JournalWriterCommit | undefined) => void
}

/** Return all host facts anew; a rollback invalidates staged store drafts from the prior attempt. */
type Prepare = (
  context: JournalReceiptStage
) => JournalSqlStorePreparation | Promise<JournalSqlStorePreparation>

type AnswerFacts = (
  context: JournalReceiptStage,
  needs: JournalHostFactsNeeded
) => JournalSqlStorePreparation | Promise<JournalSqlStorePreparation>

/** A live ownership token and worker ports; no reduced chat or writable connection lives here. */
export class SqlAgentSessionJournal {
  readonly reads: JournalSqlReads
  private closed = false
  private admitted: Promise<unknown> = Promise.resolve()
  private listener: ((commit: JournalWriterCommit) => void) | undefined

  private constructor(
    private readonly database: JournalSqlDatabase,
    readonly identity: AgentSessionJournalIdentity,
    private target: JournalWriterTarget,
    private readonly now: () => number
  ) {
    this.reads = journalSqlReads(database.readers, identity.sessionId)
  }

  static async open(options: {
    database: JournalSqlDatabase
    identity: AgentSessionJournalIdentity
    now?: () => number
  }): Promise<SqlAgentSessionJournal> {
    const { target } = await options.database.openSession(options.identity)
    return new SqlAgentSessionJournal(
      options.database,
      options.identity,
      target,
      options.now ?? Date.now
    )
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
    prepare?: Prepare,
    answerFacts?: AnswerFacts
  ): Promise<JournalWriterCommit> {
    return this.admit(async (writer) => {
      const savedAt = this.now()
      let needs: JournalHostFactsNeeded | undefined
      for (;;) {
        const context: JournalReceiptStage = { savedAt, row: receiptRow(operation) }
        const preparation: JournalSqlStorePreparation = needs
          ? await answerFacts!(context, needs)
          : ((await prepare?.(context)) ?? {})
        const facts: JournalWriterHostFacts = { identity: this.identity, ...preparation.facts }
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
          if (!(error instanceof JournalHostFactsNeededError) || !answerFacts) {
            throw error
          }
          needs = error.needs
          continue
        }
        preparation.settle?.(commit)
        staged?.settle(commit.receiptWritten ? commit.effects : undefined)
        this.listener?.(commit)
        if (operation.kind === 'epoch-replace') {
          // Public context identities need not equal the physical epoch a command targets.
          const epoch = await this.database.sessionEpoch(this.identity.sessionId)
          if (epoch === null) {
            throw new Error('a committed journal replacement has no physical epoch')
          }
          this.target = { ...this.target, epoch }
        }
        return commit
      }
    })
  }

  /** Pure readers can join preceding commands without allowing another command between reads. */
  readInOrder<T>(read: (reads: JournalSqlReads) => T | Promise<T>): Promise<T> {
    return this.admit(() => read(this.reads))
  }

  /** Refuse admission now; already admitted work retains its ownership until it drains. */
  close(): Promise<void> {
    this.closed = true
    return this.admitted.then(() => undefined)
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

function receiptRow(operation: JournalSqlStoreOperation): JournalReceiptStage['row'] {
  switch (operation.kind) {
    case 'item':
    case 'item-claiming':
      return 'item'
    case 'tombstone':
    case 'goal-withdraw':
    case 'stop':
      return 'tombstone'
    case 'dispatch':
      return 'dispatch'
    case 'submission':
      return 'submission'
    default:
      return undefined
  }
}
