import { sessionCrewChanges } from '../../orchestration/crew/crew-changes'
import { isDeepStrictEqual } from 'node:util'
import type { JournalSqlDatabase } from '../../../native-chat/agent-session-journal/database/journal-sql-database'
import type { JournalWriterEffectResult } from '../../../native-chat/agent-session-journal/journal-writer-effects'
import type { JournalOperationReceipt } from '../../../native-chat/agent-session-journal/writing/journal-row-writer'
import {
  AgentSessionStoreWriterLanes,
  stageAgentSessionStoreReceipt
} from './agent-session-store-writer-stage'
import { journalOpenRefusalError } from '../../../native-chat/agent-session-journal/replay/journal-open-failure'
import { AgentSessionJournalError } from '../../../native-chat/agent-session-journal/writing/journal-write-guards'
import type { AgentSessionStoreState } from './agent-session-store-state'
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
import { changesAgentSenderIdentity } from '../../agent-session-sender-identity-revision'

// The worker commits validated draft rows before publication; failures discard the draft.
// The promise queue preserves FIFO across transactions and staged writer receipts.

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

export type StagedStoreTransaction<T> = {
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
  private readonly writerLanes = new AgentSessionStoreWriterLanes(
    (hold) => {
      const held = this.queue.then(hold)
      this.queue = held.catch(() => {})
    },
    () => this.published
  )
  /** Loaded takeover evidence; immutable for this runtime. */
  readonly replacedRuntimes: ReadonlyMap<string, AgentSessionReplacedRuntime>

  constructor(
    private readonly journalDatabase: JournalSqlDatabase,
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

  get readOnly(): boolean {
    return this.journalDatabase.readOnly
  }

  admittedSendCount = (sessionId: string): number => this.admittedSends.get(sessionId) ?? 0

  readCommandReceipt(scope: CommandReceiptScope, operationId: string) {
    return this.journalDatabase.readCommandReceipt(scope, operationId)
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

  /** Staged into a worker writer command; co-staged receipts in one command build on each other. */
  receipt(
    apply: (draft: AgentSessionStoreState) => void,
    options: { insertOperationsIfAbsent?: true; submissionSessionId?: string } = {}
  ): JournalOperationReceipt & Required<Pick<JournalOperationReceipt, 'stage'>> {
    return {
      stage: (context) =>
        stageAgentSessionStoreReceipt(
          {
            refusal: () => (this.journalDatabase.readOnly ? readOnlyStoreRefusal() : undefined),
            lanes: this.writerLanes,
            stage: (run, base) => this.stage(run, base),
            admit: (sessionId) => this.admitSend(sessionId),
            publish: (draft) =>
              this.publish(
                draft,
                this.published,
                agentSessionStoreDraftRowWrites(this.published, draft)
              ),
            fault: (error) => this.journalDatabase.fault(error)
          },
          { apply, ...options },
          context
        )
    }
  }

  private admitSend(sessionId: string): void {
    this.admittedSends.set(sessionId, this.admittedSendCount(sessionId) + 1)
    for (const listener of this.acceptedSendListeners) {
      listener(sessionId)
    }
  }

  /** Commit a receipt separately when its command made no journal write; it settles exactly once. */
  async commitReceipt(receipt: JournalOperationReceipt): Promise<void> {
    if (!receipt.stage) {
      throw new Error('a record store receipt requires worker staging')
    }
    const staged = await receipt.stage({ savedAt: Date.now() })
    let results: JournalWriterEffectResult[] | undefined
    try {
      results = staged.effects.length > 0 ? await this.journalDatabase.effects(staged.effects) : []
    } finally {
      staged.settle(results)
    }
  }

  private async commit<T>(
    apply: (draft: AgentSessionStoreState) => T,
    inMemoryWhenReadOnly: boolean
  ): Promise<T> {
    const readOnly = this.journalDatabase.readOnly
    if (readOnly && !inMemoryWhenReadOnly) {
      throw readOnlyStoreRefusal()
    }
    const staged = this.stage(apply)
    const writes = staged.writes
    if (writes && !readOnly) {
      await this.journalDatabase.effects([
        { kind: 'store', writes, insertOperationsIfAbsent: false }
      ])
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
      adopt: () => this.publish(draft, published, writes)
    }
  }

  private publish(
    draft: AgentSessionStoreState,
    published: AgentSessionStoreState,
    writes: AgentSessionStoreRowWrites | null
  ): void {
    if (writes) {
      freezeRows(draft, writes)
      if (changesAgentSenderIdentity(published, draft, writes)) {
        this.senderIdentityRevision++
      }
      this.published = draft
      const lineageChanged =
        writes.records.remove.length > 0 ||
        writes.records.upsert.some(([id]) => {
          const before = published.records.get(id)
          return !isDeepStrictEqual(
            before?.conversationCommand,
            draft.records.get(id)?.conversationCommand
          )
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
            !isDeepStrictEqual(before.location, after.location) ||
            !isDeepStrictEqual(before.conversationCommand, after.conversationCommand)
          )
        })
      const renamed = writes.records.upsert
        .filter(
          ([id]) =>
            published.records.get(id)?.conversationName !== draft.records.get(id)?.conversationName
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
