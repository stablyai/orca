import { clearSuccessor } from './agent-session-sender-identity-revision'
import type * as usageLimitContinue from '../../../../shared/agent-session/lifecycle/stopping/agent-session-usage-limit-continue'
import type { createAgentSessionOwnerProof } from '../ownership/agent-session-owner-proof'
import { backfillAgentSessionPermissionModes } from '../ownership/agent-session-permission-backfill'
import { createAgentSessionConversationReceipts } from '../agent-session-conversation-receipts'
import {
  agentSessionOperationKey,
  type AgentSessionOperationDecision,
  type AgentSessionOperationRow
} from '../../../../shared/agent-session/lifecycle/operations/agent-session-operation-ledger'
import {
  evaluateAgentSessionMutationOperation,
  type claimAgentSessionOperationInto,
  type admitAndClaimAgentSessionOperationInto,
  type settleAgentSessionOperationInto,
  type AgentSessionMutationOperationAdmission,
  type AgentSessionOperationAdmission
} from '../ownership/agent-session-operation-admission'
import { isAgentSessionClaimKeyVerifiable } from '../ownership/agent-session-claim-key-retention'
import type { AgentSessionOwnerProbe } from '../../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import {
  agentSessionScopeKey,
  type AgentSessionExecutionLocation,
  type AgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { readAgentSessionWorkspaceAttention } from './agent-session-workspace-attention'
import type { AgentSessionOptionsReplacement } from '../../../../shared/agent-session/options/protocol/agent-session-options-replacement'
import type { AgentSessionProcessIdentityCommit } from '../ownership/agent-session-lease-transitions'
import type {
  AgentSessionFailedAcquisitionSettlement,
  AgentSessionFailedPostAcquisitionAttachmentSettlement
} from '../agent-session-acquisition-failure-settlement'
import type { AgentSessionLeaseRenewal } from '../ownership/agent-session-lease-renewal'
import {
  collectAgentSessionRestartProbes,
  type AgentSessionRestartProbeArgs
} from '../ownership/agent-session-restart-reconciliation'
import type { AgentSessionRecordCommand } from './agent-session-record-command'
import type {
  AgentSessionReserveRequest,
  AgentSessionReserveResult
} from '../ownership/agent-session-reservation-admission'
import {
  getAgentSessionConversation,
  selectWritableAgentSessionRecord,
  listAgentSessionConversations,
  requireWritableAgentSessionRecord,
  heldAgentSessionIds,
  type AgentSessionStoreState
} from './agent-session-store-state'
import { AgentSessionRecordTabs } from '../agent-session-tab-table'
import type { JournalSqlDatabase } from '../../../native-chat/agent-session-journal/database/journal-sql-database'
import type { JournalOperationReceipt } from '../../../native-chat/agent-session-journal/writing/journal-row-writer'
import { agentSessionOperationOutcomeReceipt } from '../agent-session-operation-receipt'
import { AgentSessionStoreTransactions } from './agent-session-store-transactions'
import { createAgentSessionFoundingStore } from './agent-session-founding-store'
import type {
  AgentSessionUserNameWrite,
  CompareAndSetConversationName
} from './agent-session-record-conversation-name'

/** Single-writer records/operation ledger in the host chat-journal database. */

export const AGENT_SESSION_LEASE_TTL_MS = 30_000,
  AGENT_SESSION_LEASE_RENEW_INTERVAL_MS = 10_000

export class AgentSessionRecordStore extends AgentSessionRecordTabs {
  readonly conversationReceipts: ReturnType<typeof createAgentSessionConversationReceipts>
  private clearedFrom: { lineage: object; predecessors: Map<string, string[]> } | undefined

  private constructor(
    transactions: AgentSessionStoreTransactions,
    readonly hostId: string,
    private readonly journalDatabase: JournalSqlDatabase
  ) {
    super(transactions)
    this.founding = createAgentSessionFoundingStore(transactions)
    this.conversationReceipts = createAgentSessionConversationReceipts(transactions)
  }

  /** Structural readability does not depend on which agents this host can launch.
   *  `records` must come from this database's own load. */
  static open(args: {
    journalDatabase: JournalSqlDatabase
    records: AgentSessionStoreState
    hostId: string
    legacySessionTabIds: readonly string[]
  }): AgentSessionRecordStore {
    const transactions = new AgentSessionStoreTransactions(
      args.journalDatabase,
      args.records,
      args.hostId,
      args.legacySessionTabIds
    )
    return new AgentSessionRecordStore(transactions, args.hostId, args.journalDatabase)
  }

  private get state(): AgentSessionStoreState {
    return this.transactions.state
  }

  /** Newer-build databases permit reads, never writes. */
  get readOnly(): boolean {
    return this.transactions.readOnly
  }

  backfillChatPermissionModes = (ranWithFullAccess: (provider: string) => boolean): Promise<void> =>
    backfillAgentSessionPermissionModes(this.transactions, ranWithFullAccess)

  getRecord = (sessionId: string): AgentSessionRecord | null =>
    this.state.records.get(sessionId) ?? null

  getConversation = (sessionId: string) => getAgentSessionConversation(this.state, sessionId)
  listConversations = () => listAgentSessionConversations(this.state)
  workspaceAttentionReads = (location: AgentSessionExecutionLocation) =>
    readAgentSessionWorkspaceAttention(this.journalDatabase, this.listConversations(), location)
  senderIdentityRevision = (): number => this.transactions.senderIdentityRevision
  /** Sessions a committed /clear continued into this one, derived from every held conversation
   *  (unreadable leases still count) and rebuilt only when lineage changes. */
  listClearedFrom = (sessionId: string): string[] => {
    const lineage = this.transactions.lineageRevision()
    if (this.clearedFrom?.lineage !== lineage) {
      const predecessors = new Map<string, string[]>()
      for (const conversation of this.listConversations()) {
        const successor = clearSuccessor(conversation)
        if (successor !== null) {
          predecessors.set(successor, [
            ...(predecessors.get(successor) ?? []),
            conversation.sessionId
          ])
        }
      }
      this.clearedFrom = { lineage, predecessors }
    }
    return [...(this.clearedFrom.predecessors.get(sessionId) ?? [])]
  }
  lineageRevision = (): object => this.transactions.lineageRevision()
  providerAliasOwner = (nativeId: string) => this.transactions.providerAliasOwner(nativeId)
  selectWritableRecord = (sessionId: string) =>
    selectWritableAgentSessionRecord(this.state, sessionId)
  requireWritableRecord = (sessionId: string) =>
    requireWritableAgentSessionRecord(this.state, sessionId)

  listRecords = (): AgentSessionRecord[] => [...this.state.records.values()]

  /** Replaced runtimes captured at load; absent for sessions this runtime created. */
  replacedRuntime = (sessionId: string) => this.transactions.replacedRuntimes.get(sessionId)

  /** Include unreadable records in presence queries. */
  listHeldSessionIds = (): string[] => heldAgentSessionIds(this.state)

  /** Record presence is permanent, including unreadable rows. */
  holdsRecords = (): boolean => this.state.records.size > 0 || this.state.unreadableRecords.size > 0

  listByScope(location: AgentSessionExecutionLocation): AgentSessionRecord[] {
    const scope = agentSessionScopeKey(location)
    return this.listRecords().filter((record) => agentSessionScopeKey(record.location) === scope)
  }

  updateRecord = <C extends AgentSessionRecordCommand>(
    sessionId: string,
    command: C,
    check?: () => void
  ) => this.commitRecordCommand(sessionId, command, check)

  setConversationName = (sessionId: string, name: string | null) =>
    this.updateRecord(sessionId, { kind: 'name', name, now: Date.now() })

  setUserConversationName = (sessionId: string, name: string, write: AgentSessionUserNameWrite) =>
    this.updateRecord(sessionId, { kind: 'user-name', name, write, now: Date.now() })

  compareAndSetConversationName: CompareAndSetConversationName = (
    id,
    name,
    expected,
    contextId = null
  ) =>
    this.updateRecord(id, { kind: 'name-if-current', name, expected, contextId, now: Date.now() })

  pinLaunchDirectory = (sessionId: string, launchDirectory: string): Promise<AgentSessionRecord> =>
    this.updateRecord(sessionId, { kind: 'launch-directory', launchDirectory, now: Date.now() })

  /** Unreadable records still count as present and can never grant writers. */
  isSessionUnreadable = (sessionId: string): boolean => this.state.unreadableRecords.has(sessionId)

  listOperationRows = (): AgentSessionOperationRow[] => [...this.state.operations.values()]

  getOperationRow = (callerKey: string, operationId: string): AgentSessionOperationRow | null =>
    this.state.operations.get(agentSessionOperationKey(callerKey, operationId)) ?? null

  isClaimKeyVerifiable = (keyId: string, now: number): boolean =>
    isAgentSessionClaimKeyVerifiable(this.state, keyId, now)

  reserveOwner = (
    request: AgentSessionReserveRequest,
    check?: () => void
  ): Promise<AgentSessionReserveResult> =>
    this.commitStoreCommand(
      {
        kind: 'reserve',
        request: {
          ...request,
          spawnToken:
            typeof request.spawnToken === 'function' ? request.spawnToken() : request.spawnToken
        },
        leaseTtlMs: AGENT_SESSION_LEASE_TTL_MS,
        legacyTabIds: this.transactions.legacySessionTabIds
      },
      check
    )

  readonly founding: ReturnType<typeof createAgentSessionFoundingStore>

  commitProcessIdentity = (args: AgentSessionProcessIdentityCommit): Promise<AgentSessionRecord> =>
    this.updateRecord(args.sessionId, { kind: 'process', args })

  proveOwner = (args: Parameters<ReturnType<typeof createAgentSessionOwnerProof>>[0]) =>
    this.updateRecord(args.sessionId, {
      kind: 'prove',
      args,
      leaseTtlMs: AGENT_SESSION_LEASE_TTL_MS
    })

  settleFailedAcquisition = (args: AgentSessionFailedAcquisitionSettlement) =>
    this.commitStoreCommand({ kind: 'failed-acquisition', args, attached: false })

  settleFailedPostAcquisitionAttachment = (
    args: AgentSessionFailedPostAcquisitionAttachmentSettlement
  ) => this.commitStoreCommand({ kind: 'failed-acquisition', args, attached: true })

  renewLease = (args: AgentSessionLeaseRenewal): Promise<AgentSessionRecord> =>
    this.renewLeases([args]).then(([renewed]) => renewed)

  async renewLeases(renewals: readonly AgentSessionLeaseRenewal[]): Promise<AgentSessionRecord[]> {
    return this.commitStoreCommand({
      kind: 'renew',
      renewals,
      leaseTtlMs: AGENT_SESSION_LEASE_TTL_MS
    })
  }

  async evictProvenDeadOwner(args: {
    sessionId: string
    expectedFence: number
    probe: AgentSessionOwnerProbe
    now: number
  }): Promise<AgentSessionRecord> {
    return this.updateRecord(args.sessionId, { kind: 'evict', args })
  }

  cancelUsageLimitContinue = (id: string, cut: usageLimitContinue.UsageLimitContinueIdentity) =>
    this.updateRecord(id, { kind: 'cancel-continue', cut })

  /** Reconcile loaded leases before writer admission. Newer databases keep verdicts in memory only and cannot grant writers. */
  async reconcileOnRestart(args: AgentSessionRestartProbeArgs) {
    const probes = await collectAgentSessionRestartProbes(this, args)
    return this.commitStoreCommand({ kind: 'restart', probes, now: args.now })
  }

  admitOperation = (args: AgentSessionOperationAdmission): Promise<AgentSessionOperationDecision> =>
    this.commitStoreCommand({ kind: 'admit', args })

  /** Global send ids survive caller reconnect/identity changes. */
  admitGlobalOperation = (
    args: AgentSessionOperationAdmission
  ): Promise<AgentSessionOperationDecision> =>
    this.commitStoreCommand({ kind: 'global-admit', args })

  admitMutationOperation = (args: AgentSessionMutationOperationAdmission) =>
    this.commitStoreCommand({ kind: 'admit-mutation', args })

  /** Replay evaluation writes nothing; admitMutationOperation owns the transaction. */
  evaluateMutationOperation = (args: AgentSessionMutationOperationAdmission) =>
    evaluateAgentSessionMutationOperation(this.state, args)

  /** Durable CAS decides which pending replay may run its effect; reading pending alone cannot grant it. */
  claimOperation = (args: Parameters<typeof claimAgentSessionOperationInto>[1]) =>
    this.commitStoreCommand({ kind: 'claim', args })

  admitAndClaimOperation = (args: Parameters<typeof admitAndClaimAgentSessionOperationInto>[1]) =>
    this.commitStoreCommand({ kind: 'admit-launch', args })

  recordOperationOutcome = (
    args: Parameters<typeof settleAgentSessionOperationInto>[1]
  ): Promise<void> =>
    this.transactions.commitReceipt(
      this.transactions.mutationReceipt({ kind: 'operation', operation: args })
    )

  /** Commit settlement with the journal write, including any action-owned record transformation;
   *  new submissions also clear Sleep in that draft. */
  operationOutcomeReceipt = (args: Parameters<typeof agentSessionOperationOutcomeReceipt>[1]) =>
    agentSessionOperationOutcomeReceipt(this.transactions, args)

  /** The journal commit revealing a stopped cut co-writes its withdrawal; a saved one needs none. */
  usageLimitContinueCancelReceipt = (
    id: string,
    cut: usageLimitContinue.UsageLimitContinueIdentity
  ): JournalOperationReceipt | undefined => {
    return this.transactions.mutationReceipt({ kind: 'cancel-continue', sessionId: id, cut })
  }

  /** Automatic queue admission uses the same record transition as a client's send receipt. */
  submissionReceipt = (sessionId: string) =>
    this.transactions.mutationReceipt({ kind: 'submission-wake', sessionId }, sessionId)

  onAcceptedSend = (listener: (sessionId: string) => void): (() => void) => {
    this.transactions.acceptedSendListeners.add(listener)
    return () => {
      this.transactions.acceptedSendListeners.delete(listener)
    }
  }

  admittedSendCount = (sessionId: string) => this.transactions.admittedSendCount(sessionId)

  commitOperationReceipt = (receipt: JournalOperationReceipt) =>
    this.transactions.commitReceipt(receipt)

  readCommandReceipt = (...args: Parameters<AgentSessionStoreTransactions['readCommandReceipt']>) =>
    this.transactions.readCommandReceipt(...args)

  replaceSessionOptions = (args: AgentSessionOptionsReplacement): Promise<AgentSessionRecord> =>
    this.updateRecord(args.sessionId, { kind: 'options', args })
}
