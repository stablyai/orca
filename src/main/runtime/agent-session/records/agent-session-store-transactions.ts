import {
  applyAgentSessionStoreCommand,
  type AgentSessionStoreCommand,
  type AgentSessionStoreCommandResult
} from './agent-session-store-command'
import { isDeepStrictEqual } from 'node:util'
import type { JournalSqlDatabase } from '../../../native-chat/agent-session-journal/database/journal-sql-database'
import type { JournalWriterEffectResult } from '../../../native-chat/agent-session-journal/journal-writer-effects'
import type {
  JournalOperationReceipt,
  JournalReceiptStage,
  JournalStagedReceipt
} from '../../../native-chat/agent-session-journal/writing/journal-row-writer'
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
  agentSessionStoreRowChanges,
  type AgentSessionStoreRowWrites
} from '../../../native-chat/agent-session-journal/journal-writer-store-row-changes'
import { changesAgentSenderIdentity } from '../../agent-session-sender-identity-revision'
import type { AgentSessionStoreMutation } from './agent-session-store-mutation'
import type {
  AgentSessionRecordCommand,
  AgentSessionRecordCommandResult
} from './agent-session-record-command'
import {
  applyAgentSessionStoreCacheRows,
  copyAgentSessionStoreCache,
  notifyAgentSessionStoreCacheChanges
} from './agent-session-store-cache'

// The writer owns every transition; the host publishes acknowledged row changes only.

function readOnlyStoreRefusal(): Error {
  return journalOpenRefusalError(
    new AgentSessionJournalError(
      'journal_read_only',
      'the chat records were saved by a newer Orca; this host reads them and never writes'
    )
  )
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
  private readonly receiptCommits = new WeakMap<
    JournalReceiptStage,
    { remaining: number; results: (readonly JournalWriterEffectResult[])[]; failed: boolean }
  >()
  /** Loaded takeover evidence; immutable for this runtime. */
  readonly replacedRuntimes: ReadonlyMap<string, AgentSessionReplacedRuntime>

  constructor(
    private readonly journalDatabase: JournalSqlDatabase,
    loaded: AgentSessionStoreState,
    hostId: string,
    readonly legacySessionTabIds: readonly string[]
  ) {
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

  record<C extends AgentSessionRecordCommand>(
    sessionId: string,
    command: C,
    check?: () => void
  ): Promise<AgentSessionRecordCommandResult<C>> {
    return this.executeMutation({ kind: 'record', sessionId, command }, check)
  }

  command<C extends AgentSessionStoreCommand>(
    command: C,
    check?: () => void
  ): Promise<AgentSessionStoreCommandResult<C>> {
    return this.executeMutation({ kind: 'command', command }, check)
  }

  private executeMutation<T>(input: AgentSessionStoreMutation, check?: () => void): Promise<T> {
    const run = this.queue.then(async () => {
      check?.()
      if (this.readOnly && input.kind === 'command' && input.command.kind === 'restart') {
        const next = copyAgentSessionStoreCache(this.published)
        const result = applyAgentSessionStoreCommand(next, input.command)
        attributeAgentSessionRuntime(this.published, next)
        if (result instanceof Map) {
          for (const id of result.keys()) {
            result.set(id, next.records.get(id))
          }
        }
        this.publish(next, this.published, agentSessionStoreRowChanges(this.published, next))
        return result as T
      }
      if (this.readOnly) {
        throw readOnlyStoreRefusal()
      }
      const [result] = await this.journalDatabase.effects([
        {
          kind: 'store',
          mutation: {
            input,
            runtime: {
              incarnation: agentSessionRuntimeIncarnation(),
              ends: this.published.runtimeEnds
            }
          }
        }
      ])
      if (!result || typeof result !== 'object' || !('kind' in result) || result.kind !== 'store') {
        const error = new Error('the writer returned a different store result')
        this.journalDatabase.fault(error)
        throw error
      }
      this.publishResults([result])
      return result.value as T
    })
    this.queue = run.catch(() => {})
    return run
  }

  mutationReceipt(
    mutation: AgentSessionStoreMutation | (() => AgentSessionStoreMutation),
    submissionSessionId?: string
  ): JournalOperationReceipt & Required<Pick<JournalOperationReceipt, 'stage'>> {
    return {
      stage: async (context): Promise<JournalStagedReceipt> => {
        if (this.readOnly) {
          throw readOnlyStoreRefusal()
        }
        const input = typeof mutation === 'function' ? mutation() : mutation
        const admitted = context.row === 'submission' ? submissionSessionId : undefined
        const effective =
          input.kind === 'operation' && !admitted ? { ...input, wakeSessionId: undefined } : input
        let group = this.receiptCommits.get(context)
        if (!group) {
          group = { remaining: 0, results: [], failed: false }
          this.receiptCommits.set(context, group)
        }
        const index = group.results.length
        group.results.push([])
        group.remaining++
        let adopted = false
        let settled = false
        const adopt: NonNullable<JournalStagedReceipt['adopt']> = (results) => {
          if (adopted) {
            return
          }
          adopted = true
          group.remaining--
          if (results === undefined) {
            group.failed = true
          } else if (results.length !== 1) {
            group.failed = true
            const error = new Error('the writer returned missing store results')
            this.journalDatabase.fault(error)
            throw error
          } else {
            group.results[index] = results
          }
          if (group.remaining === 0 && !group.failed) {
            try {
              this.publishResults(group.results.flat())
            } catch (error) {
              group.failed = true
              throw error
            }
          }
        }
        return {
          effects: [
            {
              kind: 'store',
              mutation: {
                input: effective,
                at: context.savedAt,
                runtime: {
                  incarnation: agentSessionRuntimeIncarnation(),
                  ends: this.published.runtimeEnds
                }
              }
            }
          ],
          adopt,
          settle: (results) => {
            if (settled) {
              return
            }
            settled = true
            adopt(results)
            if (results !== undefined && !group.failed && admitted) {
              this.admitSend(admitted)
            }
          }
        }
      }
    }
  }

  private publishResults(results: readonly JournalWriterEffectResult[]): void {
    try {
      const next = copyAgentSessionStoreCache(this.published)
      for (const result of results) {
        if (
          !result ||
          typeof result !== 'object' ||
          !('kind' in result) ||
          result.kind !== 'store'
        ) {
          throw new Error('the writer returned a different store result')
        }
        applyAgentSessionStoreCacheRows(next, result.writes)
      }
      this.publish(next, this.published, agentSessionStoreRowChanges(this.published, next))
    } catch (error) {
      this.journalDatabase.fault(error instanceof Error ? error : new Error(String(error)))
      throw error
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

  private publish(
    draft: AgentSessionStoreState,
    published: AgentSessionStoreState,
    writes: AgentSessionStoreRowWrites | null
  ): void {
    if (writes) {
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
      notifyAgentSessionStoreCacheChanges(published, draft, writes)
    }
  }
}
