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
import { writeAgentSessionStoreRows } from './agent-session-record-rows'
import {
  agentSessionRuntimeIncarnation,
  attributeAgentSessionRuntime
} from './agent-session-runtime-attribution'
import {
  beginAgentSessionRuntimeRecord,
  readAgentSessionRuntimeEnds
} from './agent-session-runtime-end-record'
import {
  agentSessionStoreDraftRowWrites,
  draftAgentSessionStoreState,
  type AgentSessionStoreRowWrites
} from './agent-session-store-draft'

// Why: records are diffed by identity, so a record changed in place would never be written. Tests and
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

  constructor(
    private readonly journalDatabase: JournalHostDatabase,
    loaded: AgentSessionStoreState
  ) {
    freezeRows(loaded, null)
    this.published = {
      ...loaded,
      runtimeEnds: readAgentSessionRuntimeEnds(journalDatabase.stateDirectory)
    }
    // Before any owner this runtime records: a crash is concluded only from a recorded start.
    beginAgentSessionRuntimeRecord(
      journalDatabase.stateDirectory,
      agentSessionRuntimeIncarnation(),
      Date.now()
    )
  }

  /** The committed state, except `operations`: it reads the journal, so an open transaction shows. */
  get state(): AgentSessionStoreState {
    return this.published
  }

  get readOnly(): boolean {
    return this.journalDatabase.readOnly
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
   * `apply`'s rows, written inside a journal transaction the caller runs on this store's connection
   * (operation rows go straight through it) and adopted once it commits. Exact without the queue:
   * `write` and `committed` run in one synchronous step, so no store transaction can commit between
   * the draft's staging and its adoption.
   */
  receipt(apply: (draft: AgentSessionStoreState) => void): JournalOperationReceipt {
    let staged: StagedStoreTransaction<void> | null = null
    return {
      write: (db) => {
        if (this.journalDatabase.readOnly) {
          throw readOnlyStoreRefusal()
        }
        if (db !== this.journalDatabase.db) {
          throw new AgentSessionJournalError(
            'journal_row_rejected',
            "an operation receipt must commit on its store's own journal connection"
          )
        }
        staged = this.stage(apply)
        const writes = staged.writes
        if (writes) {
          writeAgentSessionStoreRows(db, writes)
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
    const staged = readOnly
      ? this.stage(apply)
      : this.journalDatabase.transaction((db) => {
          const staged = this.stage(apply)
          if (staged.writes) {
            writeAgentSessionStoreRows(db, staged.writes)
          }
          return staged
        })
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
