import { backfillAgentSessionPermissionModes } from './agent-session/ownership/agent-session-permission-backfill'
import { createAgentSessionConversationReceipts } from './agent-session-conversation-receipts'
import { pinAgentSessionRecordLaunchDirectory } from './agent-session-record-launch-directory'
import {
  agentSessionOperationKey,
  type AgentSessionOperationDecision,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import {
  admitAgentSessionGlobalOperationInto,
  admitAgentSessionMutationOperation,
  evaluateAgentSessionMutationOperation,
  admitAgentSessionOperationInto,
  claimAgentSessionOperationInto,
  admitAndClaimAgentSessionOperationInto,
  type ClaimAfterAdmission,
  settleAgentSessionOperationInto,
  type AgentSessionMutationOperationAdmission,
  type AgentSessionOperationAdmission
} from './agent-session/ownership/agent-session-operation-admission'
import {
  isAgentSessionClaimKeyVerifiable,
  retireAgentSessionClaimKey
} from './agent-session/ownership/agent-session-claim-key-retention'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import {
  agentSessionScopeKey,
  type AgentSessionExecutionLocation,
  type AgentSessionOptionsReplacement,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
import {
  commitAgentSessionProcessIdentity,
  evictAgentSessionOwner,
  proveAgentSessionOwner,
  type AgentSessionProcessIdentityCommit
} from './agent-session/ownership/agent-session-lease-transitions'
import {
  settleFailedAgentSessionAcquisition,
  settleFailedAgentSessionPostAcquisitionAttachment,
  type AgentSessionFailedAcquisitionSettlement,
  type AgentSessionFailedPostAcquisitionAttachmentSettlement
} from './agent-session-acquisition-failure-settlement'
import {
  renewAgentSessionLeases,
  type AgentSessionLeaseRenewal
} from './agent-session/ownership/agent-session-lease-renewal'
import {
  applyAgentSessionRestartProbes,
  collectAgentSessionRestartProbes,
  type AgentSessionRestartProbeArgs
} from './agent-session/ownership/agent-session-restart-reconciliation'
import { replaceAgentSessionRecordOptions } from './agent-session-record-options'
import {
  commitAgentSessionReservation,
  type AgentSessionReserveRequest,
  type AgentSessionReserveResult
} from './agent-session/ownership/agent-session-reservation-admission'
import {
  getAgentSessionConversation,
  selectWritableAgentSessionRecord,
  listAgentSessionConversations,
  requireWritableAgentSessionRecord,
  heldAgentSessionIds,
  type AgentSessionStoreState
} from './agent-session-store-state'
import { AgentSessionRecordTabs } from './agent-session/agent-session-tab-table'
import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import type { JournalOperationReceipt } from '../native-chat/agent-session-journal/journal-row-writer'
import { agentSessionOperationOutcomeReceipt } from './agent-session-operation-receipt'
import { loadAgentSessionStoreRows } from './agent-session-record-rows'
import { AgentSessionStoreTransactions } from './agent-session-store-transactions'
import { createAgentSessionFoundingStore } from './agent-session-founding-store'
import {
  compareAndSetAgentSessionRecordName,
  type AgentSessionUserNameWrite,
  type CompareAndSetConversationName,
  setAgentSessionRecordConversationName,
  setAgentSessionRecordUserNameThrough
} from './agent-session-record-conversation-name'

/** Single-writer records/operation ledger in the host chat-journal database. */

export const AGENT_SESSION_LEASE_TTL_MS = 30_000,
  AGENT_SESSION_LEASE_RENEW_INTERVAL_MS = 10_000

export class AgentSessionRecordStore extends AgentSessionRecordTabs {
  readonly conversationReceipts: ReturnType<typeof createAgentSessionConversationReceipts>

  private constructor(
    transactions: AgentSessionStoreTransactions,
    readonly hostId: string
  ) {
    super(transactions)
    this.founding = createAgentSessionFoundingStore(transactions, this.firstRecordListeners)
    this.conversationReceipts = createAgentSessionConversationReceipts(transactions)
  }

  /** Structural readability does not depend on which agents this host can launch. */
  static open(args: {
    journalDatabase: JournalHostDatabase
    hostId: string
    legacySessionTabIds: readonly string[]
  }): AgentSessionRecordStore {
    const rows = loadAgentSessionStoreRows(args.journalDatabase.db)
    const transactions = new AgentSessionStoreTransactions(
      args.journalDatabase,
      rows,
      args.hostId,
      args.legacySessionTabIds
    )
    return new AgentSessionRecordStore(transactions, args.hostId)
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

  /** Names are metadata, not ownership: write unfenced; null clears. */
  setConversationName = (sessionId: string, name: string | null): Promise<AgentSessionRecord> =>
    this.mutate(sessionId, (record) =>
      setAgentSessionRecordConversationName(record, name, Date.now())
    )

  /** The user's name for the conversation; see `AgentSessionUserNameWrite`. */
  setUserConversationName = (sessionId: string, name: string, write: AgentSessionUserNameWrite) =>
    setAgentSessionRecordUserNameThrough((apply) => this.mutate(sessionId, apply), name, write)

  compareAndSetConversationName: CompareAndSetConversationName = (id, name, expected, context) =>
    compareAndSetAgentSessionRecordName((apply) => this.mutate(id, apply), name, expected, context)

  /** Launch history is metadata and does not contend with the writer lease. */
  pinLaunchDirectory = (sessionId: string, launchDirectory: string): Promise<AgentSessionRecord> =>
    this.mutate(sessionId, (record) =>
      pinAgentSessionRecordLaunchDirectory(record, launchDirectory, Date.now())
    )

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
    this.transact((draft) => {
      check?.()
      return commitAgentSessionReservation(
        draft,
        request,
        AGENT_SESSION_LEASE_TTL_MS,
        this.transactions.legacySessionTabIds
      )
    })

  readonly founding: ReturnType<typeof createAgentSessionFoundingStore>

  commitProcessIdentity = (args: AgentSessionProcessIdentityCommit): Promise<AgentSessionRecord> =>
    this.mutate(args.sessionId, (record) => commitAgentSessionProcessIdentity({ ...args, record }))

  async proveOwner(args: {
    sessionId: string
    fence: number
    link?: AgentSessionProviderHandleLink
    now: number
    leaseTtlMs?: number
  }): Promise<AgentSessionRecord> {
    return this.mutate(args.sessionId, (record) =>
      proveAgentSessionOwner({
        record,
        fence: args.fence,
        ...(args.link ? { link: args.link } : {}),
        now: args.now,
        leaseTtlMs: args.leaseTtlMs ?? AGENT_SESSION_LEASE_TTL_MS
      })
    )
  }

  settleFailedAcquisition = (args: AgentSessionFailedAcquisitionSettlement) =>
    this.transact((draft) => settleFailedAgentSessionAcquisition(draft, args))

  settleFailedPostAcquisitionAttachment = (
    args: AgentSessionFailedPostAcquisitionAttachmentSettlement
  ) => this.transact((draft) => settleFailedAgentSessionPostAcquisitionAttachment(draft, args))

  renewLease = (args: AgentSessionLeaseRenewal): Promise<AgentSessionRecord> =>
    this.renewLeases([args]).then(([renewed]) => renewed)

  async renewLeases(renewals: readonly AgentSessionLeaseRenewal[]): Promise<AgentSessionRecord[]> {
    return this.transact((draft) =>
      renewAgentSessionLeases(draft, renewals, AGENT_SESSION_LEASE_TTL_MS)
    )
  }

  async evictProvenDeadOwner(args: {
    sessionId: string
    expectedFence: number
    probe: AgentSessionOwnerProbe
    now: number
  }): Promise<AgentSessionRecord> {
    return this.mutate(args.sessionId, (record) => evictAgentSessionOwner({ ...args, record }))
  }

  transitionHandoff = (
    sessionId: string,
    transition: (record: AgentSessionRecord) => AgentSessionRecord
  ): Promise<AgentSessionRecord> => this.mutate(sessionId, transition)

  /** Reconcile loaded leases before writer admission. Newer databases keep verdicts in memory only and cannot grant writers. */
  async reconcileOnRestart(args: AgentSessionRestartProbeArgs) {
    const probes = await collectAgentSessionRestartProbes(this, args)
    return this.transact((draft) => applyAgentSessionRestartProbes(draft, probes, args.now), {
      inMemoryWhenReadOnly: true
    })
  }

  admitOperation = (args: AgentSessionOperationAdmission): Promise<AgentSessionOperationDecision> =>
    this.transact((draft) => admitAgentSessionOperationInto(draft, args))

  /** Global send ids survive caller reconnect/identity changes. */
  admitGlobalOperation = (
    args: AgentSessionOperationAdmission
  ): Promise<AgentSessionOperationDecision> =>
    this.transact((draft) => admitAgentSessionGlobalOperationInto(draft, args))

  admitMutationOperation = (args: AgentSessionMutationOperationAdmission) =>
    this.transact((draft) => admitAgentSessionMutationOperation(draft, args))

  /** Replay evaluation writes nothing; admitMutationOperation owns the transaction. */
  evaluateMutationOperation = (args: AgentSessionMutationOperationAdmission) =>
    evaluateAgentSessionMutationOperation(this.state, args)

  /** Durable CAS decides which pending replay may run its effect; reading pending alone cannot grant it. */
  claimOperation = (args: Parameters<typeof claimAgentSessionOperationInto>[1]) =>
    this.transact((draft) => claimAgentSessionOperationInto(draft, args))

  admitAndClaimOperation = (
    args: Parameters<typeof admitAndClaimAgentSessionOperationInto>[1],
    claimAfter: ClaimAfterAdmission
  ) => this.transact((draft) => admitAndClaimAgentSessionOperationInto(draft, args, claimAfter))

  recordOperationOutcome = (
    args: Parameters<typeof settleAgentSessionOperationInto>[1]
  ): Promise<void> => this.transact((draft) => settleAgentSessionOperationInto(draft, args))

  /** Commit settlement with the journal write; new submissions also clear Sleep in that draft. */
  operationOutcomeReceipt = (args: Parameters<typeof agentSessionOperationOutcomeReceipt>[1]) =>
    agentSessionOperationOutcomeReceipt(this.transactions, args)

  /** Automatic queue admission uses the same record transition as a client's send receipt. */
  submissionReceipt = (sessionId: string) =>
    this.transactions.receipt(() => {}, { submissionSessionId: sessionId })

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
    this.mutate(args.sessionId, (record) => replaceAgentSessionRecordOptions(record, args))

  /** Evaluate options against the record held by this ordered write. */
  reviseSessionOptions = <A extends { sessionId: string }>(
    revise: (record: AgentSessionRecord, args: A) => AgentSessionRecord,
    args: A
  ) => this.mutate(args.sessionId, (record) => revise(record, args))

  async retireClaimKey(keyId: string, now: number): Promise<void> {
    await this.transact((draft) => retireAgentSessionClaimKey(draft, keyId, now))
  }

  private async mutate(
    sessionId: string,
    apply: (record: AgentSessionRecord) => AgentSessionRecord
  ): Promise<AgentSessionRecord> {
    return this.transact((draft) => {
      const record = requireWritableAgentSessionRecord(draft, sessionId)
      const next = apply(record)
      draft.records.set(sessionId, next)
      return next
    })
  }
}
