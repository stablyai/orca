// Commit validated draft rows atomically before publication; failures discard the draft.
// The promise queue preserves FIFO and defers BEGIN beyond the caller's open journal transaction.

import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import type { JournalOperationReceipt } from '../native-chat/agent-session-journal/journal-row-writer'
import { journalOpenRefusalError } from '../native-chat/agent-session-journal/journal-open-failure'
import { AgentSessionJournalError } from '../native-chat/agent-session-journal/journal-write-guards'
import {
  requireWritableAgentSessionRecord,
  type AgentSessionStoreState
} from './agent-session-store-state'
import {
  insertAgentSessionOperationRowsIfAbsent,
  writeAgentSessionStoreRows
} from './agent-session-record-rows'
import { readCommandReceipt } from '../native-chat/agent-session-journal/command-receipt-table'
import type { CommandReceiptScope } from '../native-chat/agent-session-journal/command-receipt-schema'
import {
  agentSessionRuntimeIncarnation,
  attributeAgentSessionRuntime
} from './agent-session-runtime-attribution'
import {
  beginAgentSessionRuntimeRecord,
  readAgentSessionRuntimeEnds
} from './agent-session-runtime-end-record'
import {
  agentSessionReplacedRuntimes,
  type AgentSessionReplacedRuntime
} from './agent-session/agent-session-replaced-runtime'
import {
  agentSessionStoreDraftRowWrites,
  draftAgentSessionStoreState,
  type AgentSessionStoreRowWrites
} from './agent-session-store-draft'

// Identity-based diffs miss in-place edits; freeze rows in dev/tests to catch them.
const FREEZE_ROWS = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return
  }
  Object.freeze(value)
  for (const child of Object.values(value)) {
    deepFreeze(child)
  }
}

function freezeRows(
  state: AgentSessionStoreState,
  writes: AgentSessionStoreRowWrites | null
): void {
  if (!FREEZE_ROWS) {
    return
  }
  const records = writes ? writes.records.upsert.map(([key]) => key) : state.records.keys()
  for (const sessionId of records) {
    deepFreeze(state.records.get(sessionId))
  }
  const operations = writes ? writes.operations.upsert.map(([key]) => key) : state.operations.keys()
  for (const key of operations) {
    deepFreeze(state.operations.get(key))
  }
  if (!writes || writes.retiredClaimKeys) {
    state.retiredClaimKeys.forEach(deepFreeze)
  }
}

function readOnlyStoreRefusal(): Error {
  return journalOpenRefusalError(
    new AgentSessionJournalError(
      'journal_read_only',
      'the chat records were saved by a newer Orca; this host reads them and never writes'
    )
  )
}

type StagedStoreTransaction<T> = {
  result: T
  writes: AgentSessionStoreRowWrites | null
  /** Publish only after row commit. */
  adopt: () => void
}

export class AgentSessionStoreTransactions {
  private queue: Promise<unknown> = Promise.resolve()
  // Reads/reopens do not admit work; a count survives handle eviction without replaying history.
  private readonly admittedSends = new Map<string, number>()
  private published: AgentSessionStoreState
  /** Loaded takeover evidence; immutable for this runtime. */
  readonly replacedRuntimes: ReadonlyMap<string, AgentSessionReplacedRuntime>

  constructor(
    private readonly journalDatabase: JournalHostDatabase,
    loaded: AgentSessionStoreState,
    hostId: string
  ) {
    freezeRows(loaded, null)
    this.published = {
      ...loaded,
      runtimeEnds: readAgentSessionRuntimeEnds(journalDatabase.stateDirectory)
    }
    this.replacedRuntimes = agentSessionReplacedRuntimes(this.published, {
      hostId,
      incarnation: agentSessionRuntimeIncarnation()
    })
    // Before any owner this runtime records: a crash is concluded only from a recorded start.
    beginAgentSessionRuntimeRecord(
      journalDatabase.stateDirectory,
      agentSessionRuntimeIncarnation(),
      Date.now()
    )
  }

  get state(): AgentSessionStoreState {
    return this.published
  }

  get readOnly(): boolean {
    return this.journalDatabase.readOnly
  }

  admittedSendCount = (sessionId: string): number => this.admittedSends.get(sessionId) ?? 0

  readCommandReceipt(scope: CommandReceiptScope, operationId: string) {
    return readCommandReceipt(this.journalDatabase.db, scope, operationId)
  }

  /** Mutate only the draft. Newer databases refuse writes; inMemoryWhenReadOnly permits startup-derived verdicts. */
  transact<T>(
    apply: (draft: AgentSessionStoreState) => T,
    options: { inMemoryWhenReadOnly?: boolean } = {}
  ): Promise<T> {
    const run = this.queue.then(() => this.commit(apply, options.inMemoryWhenReadOnly === true))
    this.queue = run.catch(() => {})
    return run
  }

  /** Co-write in the caller's journal transaction; write/committed must run synchronously to prevent interleaving. */
  receipt(
    apply: (draft: AgentSessionStoreState) => void,
    options: { insertOperationsIfAbsent?: true; submissionSessionId?: string } = {}
  ): JournalOperationReceipt {
    let staged: StagedStoreTransaction<void> | null = null
    let admitted: string | undefined
    return {
      write: (db, row) => {
        if (this.journalDatabase.readOnly) {
          throw readOnlyStoreRefusal()
        }
        admitted = row?.kind === 'submission' ? options.submissionSessionId : undefined
        // The ledger and wake share one draft as well as one commit.
        staged = this.stage((draft) => {
          apply(draft)
          const record = admitted ? requireWritableAgentSessionRecord(draft, admitted) : undefined
          if (record?.sleptAt !== undefined) {
            const { sleptAt: _sleptAt, ...awake } = record
            draft.records.set(record.sessionId, {
              ...awake,
              updatedAt: row?.ts ?? record.updatedAt
            })
          }
        })
        const writes = staged.writes
        if (writes) {
          // TEMPORARY: ledger co-write preserves cross-family identity until every mutation uses receipts.
          if (options.insertOperationsIfAbsent) {
            insertAgentSessionOperationRowsIfAbsent(db, writes.operations.upsert)
          }
          writeAgentSessionStoreRows(
            db,
            options.insertOperationsIfAbsent
              ? { ...writes, operations: { ...writes.operations, upsert: [] } }
              : writes
          )
        }
      },
      committed: () => {
        staged?.adopt()
        if (admitted) {
          this.admittedSends.set(admitted, this.admittedSendCount(admitted) + 1)
        }
        staged = null
        admitted = undefined
      }
    }
  }

  /** Commit a receipt separately when its command made no journal write. */
  commitReceipt(receipt: JournalOperationReceipt): Promise<void> {
    const run = this.queue.then(() => {
      this.journalDatabase.transaction((db) => receipt.write(db))
      receipt.committed()
    })
    this.queue = run.catch(() => {})
    return run
  }

  private commit<T>(apply: (draft: AgentSessionStoreState) => T, inMemoryWhenReadOnly: boolean): T {
    const readOnly = this.journalDatabase.readOnly
    if (readOnly && !inMemoryWhenReadOnly) {
      throw readOnlyStoreRefusal()
    }
    const staged = this.stage(apply)
    const writes = staged.writes
    if (writes && !readOnly) {
      this.journalDatabase.transaction((db) => writeAgentSessionStoreRows(db, writes))
    }
    staged.adopt()
    return staged.result
  }

  private stage<T>(apply: (draft: AgentSessionStoreState) => T): StagedStoreTransaction<T> {
    const published = this.published
    const draft = draftAgentSessionStoreState(published)
    const result = apply(draft)
    attributeAgentSessionRuntime(published, draft)
    const writes = agentSessionStoreDraftRowWrites(published, draft)
    return {
      result,
      writes,
      adopt: () => {
        if (writes) {
          freezeRows(draft, writes)
          this.published = draft
        }
      }
    }
  }
}
