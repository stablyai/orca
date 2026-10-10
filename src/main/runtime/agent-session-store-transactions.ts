// Every agent-session store mutation: draft the published state, apply, check and write exactly the
// changed rows in one journal transaction, then publish the draft. A throw anywhere discards the
// draft, so memory never holds a change the database does not.
//
// Why a promise queue although the body is synchronous: a store call must never run its BEGIN in
// the caller's frame. A caller inside an open journal transaction on the same connection would nest
// a BEGIN, which `runJournalTransaction` does not support. The queue also keeps the FIFO order and
// the async boundary every awaiting caller was written against.

import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import type { JournalOperationReceipt } from '../native-chat/agent-session-journal/journal-row-writer'
import { journalOpenRefusalError } from '../native-chat/agent-session-journal/journal-open-failure'
import { AgentSessionJournalError } from '../native-chat/agent-session-journal/journal-write-guards'
import type { AgentSessionStoreState } from './agent-session-store-state'
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
} from './agent-session-replaced-runtime'
import {
  agentSessionStoreDraftRowWrites,
  draftAgentSessionStoreState,
  type AgentSessionStoreRowWrites
} from './agent-session-store-draft'

// Why: rows are diffed by identity, so a row changed in place would never be written. Tests and
// development builds make that a TypeError; packaged builds skip the walk.
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

/** What every write gets on a database a newer Orca wrote: the refusal clients print as "update". */
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
  /** Publishes the draft. Only once its rows have committed. */
  adopt: () => void
}

export class AgentSessionStoreTransactions {
  private queue: Promise<unknown> = Promise.resolve()
  private published: AgentSessionStoreState
  /** What this runtime took over from the runtimes before it, as loaded; never changes after. */
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

  /** The committed state. A transaction in flight never shows here until its rows have landed. */
  get state(): AgentSessionStoreState {
    return this.published
  }

  get readOnly(): boolean {
    return this.journalDatabase.readOnly
  }

  readCommandReceipt(scope: CommandReceiptScope, operationId: string) {
    return readCommandReceipt(this.journalDatabase.db, scope, operationId)
  }

  /**
   * `apply` changes only the draft it is given. On a database a newer Orca wrote every transaction
   * is refused, except one marked `inMemoryWhenReadOnly`: it is published without a write, for a
   * verdict re-derived at every start.
   */
  transact<T>(
    apply: (draft: AgentSessionStoreState) => T,
    options: { inMemoryWhenReadOnly?: boolean } = {}
  ): Promise<T> {
    const run = this.queue.then(() => this.commit(apply, options.inMemoryWhenReadOnly === true))
    this.queue = run.catch(() => {})
    return run
  }

  /**
   * `apply`'s rows, written inside a journal transaction the caller runs and adopted once it
   * commits. Exact without the queue: `write` and `committed` run in one synchronous step, so no
   * store transaction can commit between the draft's staging and its adoption.
   */
  receipt(
    apply: (draft: AgentSessionStoreState) => void,
    options: { insertOperationsIfAbsent?: true } = {}
  ): JournalOperationReceipt {
    let staged: StagedStoreTransaction<void> | null = null
    return {
      write: (db) => {
        if (this.journalDatabase.readOnly) {
          throw readOnlyStoreRefusal()
        }
        staged = this.stage(apply)
        const writes = staged.writes
        if (writes) {
          // TEMPORARY: ledger co-write preserves cross-family identity until every mutation uses receipts.
          if (options.insertOperationsIfAbsent) {
            insertAgentSessionOperationRowsIfAbsent(db, writes.operations.upsert)
          } else {
            writeAgentSessionStoreRows(db, writes)
          }
        }
      },
      committed: () => {
        staged?.adopt()
        staged = null
      }
    }
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
