import { randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import {
  JournalHostFactsNeededError,
  journalMailSenderKey,
  type JournalWriterHostFacts
} from './journal-writer-host-facts'
import { orchestrationMailNotice } from '../../../shared/agent-session/agent-session-message-source'
import type { JournalTransactionalDatabase } from './database/journal-host-database'
import type { JournalReducerState } from './projection/journal-reducer'
import type { JournalRow } from './durable-rows/journal-row-schema'
import type { JournalWriterTarget } from './journal-writer-command'
import type { QueuedMessageOwed } from './queued-messages/queued-message-consume-error'
import {
  createJournalStoreCollaborators,
  type JournalStoreCollaborators
} from './store-lifecycle/journal-store-collaborators'
import {
  JournalGoalAttachmentInverse,
  type JournalGoalAttachmentSnapshot
} from './writing/journal-goal-attachment-inverse'
import { JournalWriteQueue } from './writing/journal-write-queue'
import { JournalWriterChanges, type JournalWriterCommit } from './journal-writer-changes'
import { JournalSqlReducer } from './journal-sql-reducer'
import { JournalSqlScope } from './journal-sql-scope'
import { readJournalSqlMeta } from './journal-sql-meta'
import { publishJournalWriterEpoch } from './journal-writer-epoch'
import { journalInputOrder } from './input-order/journal-input-order'
import {
  advanceJournalOutcomeSource,
  journalOutcomeSource,
  startJournalOutcomeLog
} from './outcomes/journal-outcome-format'
import { persistJournalOutcomeTransition } from './outcomes/journal-outcome-table'
import { journalStoppedUsageLimitCut } from './context-epochs/journal-stopped-usage-limit-cut'
import { applyJournalWriterEffect } from './journal-writer-effects'
import type { UsageLimitContinueIdentity } from '../../../shared/agent-session/lifecycle/agent-session-usage-limit-continue'
import {
  journalContextCursor,
  physicalJournalCursor,
  projectJournalRows
} from './context-epochs/journal-context-cursor'
import type { JournalRecoveryJournal } from './submissions/journal-pending-submission-recovery'

/** One command's collaborators: today's planning code over SQL state that each write reloads. */
export class JournalWriterSession {
  readonly collaborators: JournalStoreCollaborators
  readonly goalAttachments: JournalGoalAttachmentInverse
  private reducer: JournalSqlReducer | null = null
  private readonly queue: JournalWriteQueue
  private readonly changes = new JournalWriterChanges()
  private readonly inputKeys = new Map<string, boolean>()
  private written: JournalRow[] = []
  /** A stopped cut this command's writes withdrew, for the host to adopt its staged record. */
  withdrewCut: UsageLimitContinueIdentity | undefined
  /** The rows of the write in progress, for effects bound to them. */
  lastRows: readonly JournalRow[] = []
  private inputChanged = false
  private lastScope: JournalSqlScope | null = null

  constructor(
    readonly db: Database.Database,
    private readonly stateDirectory: string,
    private target: JournalWriterTarget,
    private readonly facts: JournalWriterHostFacts,
    savedAt: number
  ) {
    const { sessionId } = target
    this.queue = new JournalWriteQueue(sessionId)
    this.goalAttachments = new JournalGoalAttachmentInverse(sessionId)
    if (facts.goals) {
      this.goalAttachments.adopt(facts.goals)
    }
    const database: JournalTransactionalDatabase = {
      db,
      readOnly: false,
      stateDirectory,
      transaction: (run, _streamed, committed) => this.savepoint(run, committed)
    }
    const held = new Set(facts.editHeld ?? [])
    this.collaborators = createJournalStoreCollaborators({
      notifyCommitted: () => undefined,
      identity: facts.identity,
      now: () => savedAt,
      mintEpoch: randomUUID,
      serialize: (run) => this.queue.serialize(run),
      database: () => database,
      state: () => this.current().state,
      readOnly: () => false,
      cursor: () => journalContextCursor(this.current().state),
      adopt: (loaded) => this.adoptEpoch(loaded.state),
      prepare: (connection, rows, at, finishFold) => this.persist(connection, rows, at, finishFold),
      commit: (rows, _savedAt, inputChanged) => {
        this.written.push(...rows)
        this.inputChanged ||= inputChanged === true
      },
      journal: () => ({
        reopenFloor: () => facts.reopenFloor ?? null,
        appendItem: (...args) => this.collaborators.itemAppender.append(...args)
      }),
      enqueue: (build, receipt) => this.collaborators.rowWriter.enqueue(build, receipt),
      editHeld: (messageId) => held.has(messageId),
      goalAttachments: this.goalAttachments
    })
    this.collaborators.queuedMessages.mailUnavailable = (card) =>
      this.mailUnavailable(card.body.from)
  }

  get state(): JournalReducerState {
    return this.current().state
  }

  cursor = () => journalContextCursor(this.current().state)

  /** The command-local journal recovery procedures read and write through. */
  readonly journal: JournalRecoveryJournal = recoveryJournal(this)

  /** The host's staged view of what a rewind leaves; the writer proves it in the command. */
  get rewound() {
    return this.facts.rewound
  }

  /** Asked by a consume after the writer has validated the card it hands over. */
  owed = (): QueuedMessageOwed => {
    if (this.facts.owed === undefined) {
      throw new JournalHostFactsNeededError({ owed: true })
    }
    return this.facts.owed
  }

  /** Every admitted write, including ones queued behind a reentrant one, finishes inside the command. */
  async finish(): Promise<
    Omit<JournalWriterCommit, 'effects'> & {
      rows: JournalRow[]
      goals: JournalGoalAttachmentSnapshot
    }
  > {
    await this.queue.drain()
    const state = this.current().state
    return {
      cursor: journalContextCursor(state),
      inputChanged: this.inputChanged,
      ...this.changes.finish(this.lastScope ?? this.scope(), state),
      inputKeys: [...this.inputKeys],
      rows: this.written,
      goals: this.goalAttachments.snapshot(),
      ...(this.withdrewCut ? { withdrewCut: this.withdrewCut } : {})
    }
  }

  /** A published epoch's state becomes its projection in the publishing transaction. */
  private adoptEpoch(state: JournalReducerState): void {
    publishJournalWriterEpoch(this.db, state, this.target.ownerToken, () => this.current().state)
    this.target = { ...this.target, epoch: state.epoch }
    this.reducer = null
  }

  get sessionId(): string {
    return this.target.sessionId
  }

  /** The command's projection scope: the epoch its ready projection covers. */
  scopePrefix(): [string, string] {
    return (this.lastScope ?? this.scope()).prefix
  }

  private mailUnavailable(from: AgentMessageSource | undefined): boolean {
    if (!from || !orchestrationMailNotice(from)) {
      return false
    }
    const key = journalMailSenderKey(from)
    const known = this.facts.mail?.find(([sender]) => sender === key)
    if (!known) {
      throw new JournalHostFactsNeededError({ mail: [from] })
    }
    return known[1]
  }

  private scope(): JournalSqlScope {
    const meta = readJournalSqlMeta(this.db, this.target)
    return new JournalSqlScope(this.db, this.target.sessionId, meta.scope)
  }

  /** A reducer shell lives for one write: decoded values never outlive the rows they were read from. */
  private current(): JournalSqlReducer {
    if (this.reducer) {
      return this.reducer
    }
    const { db, target } = this
    const meta = readJournalSqlMeta(db, target)
    const source = journalOutcomeSource(db, target.sessionId, target.epoch)
    const through =
      source?.through ??
      Number(
        db
          .prepare(`SELECT MAX(seq) AS sequence
      FROM journal_rows WHERE session_id=? AND epoch=?`)
          .get(target.sessionId, target.epoch)?.sequence ?? 0
      )
    if (through !== meta.through) {
      throw new Error('journal projection no longer covers the saved chat')
    }
    const scope = new JournalSqlScope(db, target.sessionId, meta.scope)
    // The host's Stop settlement is memory-only; every command's planning sees it, nothing saves it.
    const reducer = new JournalSqlReducer(scope, target.epoch, this.facts.stopSettle)
    if (reducer.state.lastSequence !== meta.through) {
      throw new Error('journal projection writer has stale coverage')
    }
    this.lastScope = scope
    this.reducer = reducer
    return reducer
  }

  /** A stopped cut and its withdrawal commit together, so no reader sees it schedulable. */
  private withdrawStoppedCut(db: Database.Database, rows: readonly JournalRow[]): void {
    const { facts } = this
    const cut =
      facts.withdrawsStoppedCuts && journalStoppedUsageLimitCut(this.current().state, rows)
    if (!cut) {
      return
    }
    const known = facts.stoppedCut
    if (known?.cut.turnItemId !== cut.turnItemId || known.cut.resetsAt !== cut.resetsAt) {
      throw new JournalHostFactsNeededError({ stoppedCut: cut })
    }
    if (known.store) {
      applyJournalWriterEffect(db, this.stateDirectory, known.store)
    }
    this.withdrewCut = cut
  }

  private savepoint<T>(run: (db: Database.Database) => T, committed?: (result: T) => void): T {
    const { db } = this
    db.exec('SAVEPOINT journal_write')
    const withdrewCut = this.withdrewCut
    let result: T
    try {
      result = run(db)
      db.exec('RELEASE journal_write')
    } catch (error) {
      db.exec('ROLLBACK TO journal_write; RELEASE journal_write')
      this.withdrewCut = withdrewCut
      throw error
    } finally {
      // Planning reads of the next write start from what this one left.
      this.reducer = null
    }
    committed?.(result)
    return result
  }

  private persist(
    db: Database.Database,
    rows: readonly JournalRow[],
    savedAt: number,
    finishFold?: (draft: JournalReducerState) => void
  ): () => void {
    // Planning's lazy index upkeep stays out of this row's change order, as it does on the host,
    // where it touches the live fold and only the draft records changes.
    this.reducer = null
    const reducer = this.current()
    // As the host's prepare does: legacy cards still in their old table overlay the fold first.
    this.collaborators.queuedMessages.inputState()
    const { state } = reducer
    const previous = journalOutcomeSource(db, state.sessionId, state.epoch)
    const source =
      previous ??
      startJournalOutcomeLog(db, state.sessionId, state.epoch, state.lastSequence, savedAt)
    if (source.through !== state.lastSequence) {
      throw new Error('journal outcome writer has stale coverage')
    }
    this.lastRows = rows
    const abort = new AbortController()
    const keys = journalInputOrder(state).captureKeys(new Set(), abort.signal)
    try {
      const transition = reducer.transition()
      persistJournalOutcomeTransition(
        db,
        {
          ...transition,
          changes: (reset) => {
            const entries = transition.changes(reset)
            this.changes.record(entries)
            return entries
          }
        },
        source,
        rows,
        savedAt,
        !previous || previous.format < 2,
        (next) => {
          finishFold?.(next)
          journalInputOrder(next).cards.ensure(next)
        }
      )
      advanceJournalOutcomeSource(db, state.sessionId, state.epoch, state.lastSequence)
      db.prepare(`UPDATE journal_proj_meta SET through_seq=?
        WHERE session_id=? AND owner_token=?`).run(
        state.lastSequence,
        state.sessionId,
        this.target.ownerToken
      )
      this.withdrawStoppedCut(db, rows)
      for (const [key, present] of keys.changes) {
        if (!this.inputKeys.has(key)) {
          this.inputKeys.set(key, present)
        }
      }
    } finally {
      abort.abort()
    }
    return () => undefined
  }

  /** The rows a receipt in this write binds to, in the public context's coordinates. */
  projected(rows: readonly JournalRow[]): JournalRow[] {
    return projectJournalRows(this.current().state, rows)
  }
}

function recoveryJournal(session: JournalWriterSession): JournalRecoveryJournal {
  return {
    get inputOrder() {
      return journalInputOrder(session.state)
    },
    resolveDispatch: (...args) => session.collaborators.submissionWriter.resolveDispatch(...args),
    get queuedMessages() {
      return session.collaborators.queuedMessages
    },
    physicalCursor: () => physicalJournalCursor(session.state),
    itemBody: (itemId) => session.state.items.get(itemId)?.body ?? null
  }
}
