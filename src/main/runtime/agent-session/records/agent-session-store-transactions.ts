import { sessionCrewChanges } from '../../orchestration/crew/crew-changes'
import type { JournalHostDatabase } from '../../../native-chat/agent-session-journal/database/journal-host-database'
import type { JournalOperationReceipt } from '../../../native-chat/agent-session-journal/writing/journal-row-writer'
import { journalOpenRefusalError } from '../../../native-chat/agent-session-journal/replay/journal-open-failure'
import { AgentSessionJournalError } from '../../../native-chat/agent-session-journal/writing/journal-write-guards'
import {
  requireWritableAgentSessionRecord,
  type AgentSessionStoreState
} from './agent-session-store-state'
import {
  insertAgentSessionOperationRowsIfAbsent,
  writeAgentSessionStoreRows
} from './agent-session-record-rows'
import { readCommandReceipt } from '../../../native-chat/agent-session-journal/writing/command-receipt-table'
import type { CommandReceiptScope } from '../../../native-chat/agent-session-journal/writing/command-receipt-schema'
import {
  agentSessionRuntimeIncarnation,
  attributeAgentSessionRuntime
} from '../agent-session-runtime-attribution'
import {
  beginAgentSessionRuntimeRecord,
  readAgentSessionRuntimeEnds
} from './agent-session-runtime-end-record'
import {
  agentSessionReplacedRuntimes,
  type AgentSessionReplacedRuntime
} from '../agent-session-replaced-runtime'
import {
  agentSessionStoreDraftRowWrites,
  draftAgentSessionStoreState,
  type AgentSessionStoreRowWrites
} from './agent-session-store-draft'
import { changesAgentSenderIdentity } from './agent-session-sender-identity-revision'
import { AgentSessionProviderAliasIndex } from './agent-session-provider-alias-index'

// Commit validated draft rows atomically before publication; failures discard the draft.
// The promise queue preserves FIFO and defers BEGIN beyond the caller's open journal transaction.

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
  draft: AgentSessionStoreState
  writes: AgentSessionStoreRowWrites | null
  /** Publish only after row commit. */
  adopt: () => void
}

export class AgentSessionStoreTransactions {
  private queue: Promise<unknown> = Promise.resolve()
  // Reads/reopens do not admit work; a count survives handle eviction without replaying history.
  private readonly admittedSends = new Map<string, number>()
  readonly acceptedSendListeners = new Set<(sessionId: string) => void>()
  private published: AgentSessionStoreState
  /** Moves only when a commit changes what chat sender identity reads. */
  senderIdentityRevision = 0
  /** Replaced only when a record joins or leaves, or a /clear links one conversation to the next:
   *  lookups derived from every record's lineage stay valid across admission and lease writes. */
  private lineage: object = {}
  /** Built on first use; kept by each committed record write, dropped if the unreadable set moves. */
  private providerAliases: AgentSessionProviderAliasIndex | null = null
  /** Receipts co-written in one transaction build on each other's drafts, so adoption keeps both. */
  private staged: { transaction: number; draft: AgentSessionStoreState } | null = null
  /** Loaded takeover evidence; immutable for this runtime. */
  readonly replacedRuntimes: ReadonlyMap<string, AgentSessionReplacedRuntime>

  constructor(
    private readonly journalDatabase: JournalHostDatabase,
    loaded: AgentSessionStoreState,
    hostId: string,
    readonly legacySessionTabIds: readonly string[]
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

  lineageRevision(): object {
    return this.lineage
  }

  /** The chat whose provider handle chain names `nativeId`, from the commit-kept alias index. */
  providerAliasOwner(nativeId: string): string | null {
    this.providerAliases ??= new AgentSessionProviderAliasIndex(this.published)
    return this.providerAliases.owner(nativeId)
  }

  historyRowOwners(rowSessionId: string): string[] {
    this.providerAliases ??= new AgentSessionProviderAliasIndex(this.published)
    return this.providerAliases.matchingHistoryOwners(rowSessionId)
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
        const transaction = this.journalDatabase.transactionNumber
        const base = this.staged?.transaction === transaction ? this.staged.draft : this.published
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
        }, base)
        this.staged = { transaction, draft: staged.draft }
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
        if (this.staged?.draft === staged?.draft) {
          this.staged = null
        }
        if (admitted) {
          this.admittedSends.set(admitted, this.admittedSendCount(admitted) + 1)
          for (const listener of this.acceptedSendListeners) {
            listener(admitted)
          }
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

  private stage<T>(
    apply: (draft: AgentSessionStoreState) => T,
    published = this.published
  ): StagedStoreTransaction<T> {
    const draft = draftAgentSessionStoreState(published)
    const result = apply(draft)
    attributeAgentSessionRuntime(published, draft)
    const writes = agentSessionStoreDraftRowWrites(published, draft)
    return {
      result,
      draft,
      writes,
      adopt: () => {
        if (writes) {
          freezeRows(draft, writes)
          if (changesAgentSenderIdentity(published, draft, writes)) {
            this.senderIdentityRevision++
          }
          this.published = draft
          if (published.unreadableRecords !== draft.unreadableRecords) {
            this.providerAliases = null
          } else {
            this.providerAliases?.applyCommitted(draft, writes.records)
          }
          const lineageChanged =
            writes.records.remove.length > 0 ||
            writes.records.upsert.some(([id]) => {
              const before = published.records.get(id)
              return before?.conversationCommand !== draft.records.get(id)?.conversationCommand
            })
          if (lineageChanged) {
            this.lineage = {}
          }
          const topologyChanged =
            writes.sessionTabs !== null ||
            writes.records.remove.length > 0 ||
            writes.records.upsert.some(([id]) => {
              const before = published.records.get(id)
              const after = draft.records.get(id)
              return (
                !before ||
                !after ||
                before.lease.claimStatus !== after.lease.claimStatus ||
                before.provider !== after.provider ||
                before.location !== after.location ||
                before.conversationCommand !== after.conversationCommand
              )
            })
          const renamed = writes.records.upsert
            .filter(
              ([id]) =>
                published.records.get(id)?.conversationName !==
                draft.records.get(id)?.conversationName
            )
            .map(([id]) => id)
          if (topologyChanged) {
            sessionCrewChanges.notify(new Set(['records']))
          } else if (renamed.length) {
            sessionCrewChanges.notify(
              Object.assign(new Set(['names'] as const), { recordIds: renamed })
            )
          }
        }
      }
    }
  }
}
