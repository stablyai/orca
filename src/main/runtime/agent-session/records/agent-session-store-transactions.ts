import { AgentSessionProviderAliasIndex } from './agent-session-provider-alias-index'
import {
  applyAgentSessionStoreCommand,
  type AgentSessionStoreCommand,
  type AgentSessionStoreCommandResult
} from './agent-session-store-command'
import type { JournalSqlDatabase } from '../../../native-chat/agent-session-journal/database/journal-sql-database'
import type { JournalWriterEffectResult } from '../../../native-chat/agent-session-journal/journal-writer-effects'
import type {
  JournalOperationReceipt,
  JournalReceiptStage,
  JournalStagedReceipt
} from '../../../native-chat/agent-session-journal/writing/journal-row-writer'
import { assertJournalChatReadable } from '../../../native-chat/agent-session-journal/replay/journal-open-failure'
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
import type { AgentSessionStoreMutation } from './agent-session-store-mutation'
import type {
  AgentSessionRecordCommand,
  AgentSessionRecordCommandResult
} from './agent-session-record-command'
import {
  adoptAgentSessionStoreCachePatch,
  copyAgentSessionStoreCache,
  prepareAgentSessionStoreCachePatch,
  agentSessionStoreCacheChanges,
  notifyAgentSessionStoreCacheChanges
} from './agent-session-store-cache'

export class AgentSessionStoreTransactions {
  private queue: Promise<unknown> = Promise.resolve()
  // Reads/reopens do not admit work; a count survives handle eviction without replaying history.
  private readonly admittedSends = new Map<string, number>()
  readonly acceptedSendListeners = new Set<(sessionId: string) => void>()
  readonly deathEvidenceListeners = new Set<(sessionId: string) => void>()
  readonly firstRecordListeners = new Set<() => void>()
  private published: AgentSessionStoreState
  /** Moves only when a commit changes what chat sender identity reads. */
  senderIdentityRevision = 0
  /** Lineage survives admission and lease writes; membership and committed clear invalidate it. */
  private lineage: object = {}
  private providerAliases: AgentSessionProviderAliasIndex | null = null
  private readonly receiptCommits = new WeakMap<
    JournalReceiptStage,
    { remaining: number; results: (readonly JournalWriterEffectResult[])[]; failed: boolean }
  >()
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

  providerAliasOwner(nativeId: string): string | null {
    this.providerAliases ??= new AgentSessionProviderAliasIndex(this.published)
    return this.providerAliases.owner(nativeId)
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
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: executeMutation preserves the command/result correlation enforced by its typed public entry points.
        return result as T
      }
      assertJournalChatReadable(this.readOnly)
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
      const [store] = this.publishResults([result])
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store effect returns the result of this exact typed mutation.
      return store.value as T
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
        assertJournalChatReadable(this.readOnly)
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
              this.admittedSends.set(admitted, this.admittedSendCount(admitted) + 1)
              this.acceptedSendListeners.forEach((listener) => listener(admitted))
            }
          }
        }
      }
    }
  }

  private publishResults(results: readonly JournalWriterEffectResult[]) {
    try {
      const stores = results.map((result) => {
        if (
          !result ||
          typeof result !== 'object' ||
          !('kind' in result) ||
          result.kind !== 'store'
        ) {
          throw new Error('the writer returned a different store result')
        }
        return result
      })
      const patch = prepareAgentSessionStoreCachePatch(
        this.published,
        stores.map((result) => result.writes)
      )
      this.publish(patch.next, patch.before, patch.writes, () => {
        adoptAgentSessionStoreCachePatch(this.published, patch.next, patch.writes!)
      })
      return stores
    } catch (error) {
      this.journalDatabase.fault(error instanceof Error ? error : new Error(String(error)))
      throw error
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
    writes: AgentSessionStoreRowWrites | null,
    adopt?: () => void
  ): void {
    if (writes) {
      const heldBefore =
        this.published.records.size > 0 || this.published.unreadableRecords.size > 0
      const changes = agentSessionStoreCacheChanges(published, draft, writes)
      if (changes.senderIdentity) {
        this.senderIdentityRevision++
      }
      if (changes.lineage) {
        this.lineage = {}
      }
      if (adopt) {
        adopt()
      } else {
        this.published = draft
      }
      if (published.unreadableRecords !== draft.unreadableRecords) {
        this.providerAliases = null
      } else {
        this.providerAliases?.applyCommitted(this.published, writes.records)
      }
      notifyAgentSessionStoreCacheChanges(published, draft, writes)
      for (const id of changes.deaths) {
        this.deathEvidenceListeners.forEach((listener) => listener(id))
      }
      if (
        !heldBefore &&
        (this.published.records.size > 0 || this.published.unreadableRecords.size > 0)
      ) {
        this.firstRecordListeners.forEach((listener) => listener())
      }
    }
  }
}
