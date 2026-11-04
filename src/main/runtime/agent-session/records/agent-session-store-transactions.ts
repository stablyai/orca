import { publishAgentSessionStoreChanges } from './agent-session-store-publication'
import type { SurfaceJointResult } from '../../../workspace-surfaces/surface-joint-transaction'
import { AgentSessionTabTable } from '../agent-session-tab-table'
import { freezeRows } from './agent-session-store-row-freeze'
import { stageAgentSessionMembership } from './agent-session-store-membership-plan'
import type { SurfaceStorageMutation } from '../../../../shared/workspace-surfaces/surface-storage-command'
import { changesAgentSenderIdentity } from '../../agent-session-sender-identity-revision'
import { clearSuccessor } from '../../agent-session-sender-identity-revision'
import { AgentSessionRecordLineage } from '../../agent-session-record-lineage'
import { listAgentSessionConversations } from './agent-session-store-state'
import { sessionCrewChanges } from '../../orchestration/crew/crew-changes'
import type { JournalHostDatabase } from '../../../native-chat/agent-session-journal/journal-host-database'
import type { JournalOperationReceipt } from '../../../native-chat/agent-session-journal/journal-row-writer'
import { journalOpenRefusalError } from '../../../native-chat/agent-session-journal/journal-open-failure'
import { AgentSessionJournalError } from '../../../native-chat/agent-session-journal/journal-write-guards'
import {
  requireWritableAgentSessionRecord,
  type AgentSessionStoreState
} from './agent-session-store-state'
import type { CommandReceiptScope } from '../../../native-chat/agent-session-journal/command-receipt-schema'
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

// Commit validated draft rows atomically before publication; failures discard the draft.
// The promise queue preserves FIFO and defers BEGIN beyond the caller's open journal transaction.

// Identity-based diffs miss in-place edits; freeze rows in dev/tests to catch them.
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
  /** Moves only when a committed draft changes chat sender identity. */
  senderIdentityRevision = 0
  readonly predecessors = new AgentSessionRecordLineage()
  /** Replaced only when a record joins or leaves, or a /clear links one conversation to the next:
   *  lookups derived from every record's lineage stay valid across admission and lease writes. */
  private lineage: object = {}
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
    for (const record of listAgentSessionConversations(this.published)) {
      this.predecessors.set(record.sessionId, clearSuccessor(record))
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

  notifyCommitted(notify: () => void): void {
    this.journalDatabase.notifyCommitted(notify)
  }

  /** Prepared records stay in History; current membership changes only through the common owner. */
  commitSurfaceCommands(
    commands: readonly SurfaceStorageMutation[],
    admit?: () => void,
    afterCommitted?: (result: SurfaceJointResult) => void
  ) {
    const run = this.queue.then(async () => {
      const commit = this.journalDatabase.surfaceCommands
      if (!commit) {
        throw new Error('Native membership requires its profile surface owner')
      }
      return commit(
        commands,
        (result) => {
          const host = result.surfaces.at(-1)?.host
          if (!host?.nativeTabs) {
            throw new Error('Committed native membership is missing')
          }
          this.published = {
            ...this.published,
            sessionTabs: new AgentSessionTabTable(
              host.nativeTabs.map(({ tabId, sessionId }) => [tabId, sessionId])
            )
          }
          this.journalDatabase.notifyCommitted(() =>
            sessionCrewChanges.notify(new Set(['records']))
          )
        },
        admit,
        afterCommitted
      )
    })
    this.queue = run.catch(() => {})
    return run
  }

  get state(): AgentSessionStoreState {
    return this.published
  }

  lineageRevision(): object {
    return this.lineage
  }

  get readOnly(): boolean {
    return this.journalDatabase.readOnly
  }

  admittedSendCount = (sessionId: string): number => this.admittedSends.get(sessionId) ?? 0

  readCommandReceipt(scope: CommandReceiptScope, operationId: string) {
    return this.journalDatabase.read(async (read) =>
      (await read.receipts(scope, [operationId])).get(operationId)!
    )
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
          stageAgentSessionMembership(db, base, staged.draft, staged.writes)
          db.add({
            kind: 'store',
            writes,
            insertOperationsIfAbsent: options.insertOperationsIfAbsent === true
          })
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
            const sessionId = admitted
            this.journalDatabase.notifyCommitted(() => listener(sessionId))
          }
        }
        staged = null
        admitted = undefined
      }
    }
  }

  /** Commit a receipt separately when its command made no journal write. */
  commitReceipt(receipt: JournalOperationReceipt): Promise<void> {
    const run = this.queue.then(() =>
      this.journalDatabase.transaction(
        (db) => receipt.write(db),
        false,
        () => receipt.committed()
      )
    )
    this.queue = run.catch(() => {})
    return run
  }

  private async commit<T>(
    apply: (draft: AgentSessionStoreState) => T,
    inMemoryWhenReadOnly: boolean
  ): Promise<T> {
    if (this.journalDatabase.readOnly) {
      if (!inMemoryWhenReadOnly) {
        throw readOnlyStoreRefusal()
      }
      const staged = this.stage(apply)
      staged.adopt()
      return staged.result
    }
    const staged = await this.journalDatabase.transaction(
      (plan) => {
        const staged = this.stage(apply)
        if (staged.writes) {
          stageAgentSessionMembership(plan, this.published, staged.draft, staged.writes)
          plan.add({ kind: 'store', writes: staged.writes, insertOperationsIfAbsent: false })
        }
        return staged
      },
      false,
      (staged) => staged.adopt()
    )
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
          for (const id of writes.records.remove) {
            this.predecessors.set(id, null)
          }
          for (const [id] of writes.records.upsert) {
            this.predecessors.set(id, clearSuccessor(draft.records.get(id)!))
          }
          this.published = draft
          const lineageChanged =
            writes.records.remove.length > 0 ||
            writes.records.upsert.some(([id]) => {
              const before = published.records.get(id)
              return before?.conversationCommand !== draft.records.get(id)?.conversationCommand
            })
          if (lineageChanged) {
            this.lineage = {}
          }
          publishAgentSessionStoreChanges(this.journalDatabase, published, draft, writes)
        }
      }
    }
  }
}
