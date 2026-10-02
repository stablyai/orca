/** Durable single-writer session records and their operation ledger, as rows in the host's chat
 *  journal database. */

import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import {
  commitConversationClearRecord,
  commitConversationCommandRecord,
  type AgentSessionConversationClear
} from './agent-session-conversation-command-record'
import { setAgentSessionRecordConversationName } from './agent-session-record-conversation-name'

import {
  agentSessionOperationKey,
  type AgentSessionOperationClaim,
  type AgentSessionOperationDecision,
  type AgentSessionOperationOutcome,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import {
  admitAgentSessionGlobalOperationInto,
  admitAgentSessionMutationOperation,
  evaluateAgentSessionMutationOperation,
  admitAgentSessionOperationInto,
  claimAgentSessionOperationInto,
  settleAgentSessionOperationInto,
  type AgentSessionMutationOperationAdmission,
  type AgentSessionOperationAdmission
} from './agent-session-operation-admission'
import {
  isAgentSessionClaimKeyVerifiable,
  retireAgentSessionClaimKey
} from './agent-session-claim-key-retention'
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
} from './agent-session-lease-transitions'
import {
  settleFailedAgentSessionAcquisition,
  settleFailedAgentSessionPostAcquisitionAttachment,
  type AgentSessionFailedAcquisitionSettlement,
  type AgentSessionFailedPostAcquisitionAttachmentSettlement
} from './agent-session-acquisition-failure-settlement'
import {
  renewAgentSessionLeases,
  type AgentSessionLeaseRenewal
} from './agent-session-lease-renewal'
import {
  applyAgentSessionRestartProbes,
  collectAgentSessionRestartProbes,
  type AgentSessionRestartProbeArgs
} from './agent-session-restart-reconciliation'
import { replaceAgentSessionRecordOptions } from './agent-session-record-options'
import {
  commitAgentSessionReservation,
  type AgentSessionReserveRequest,
  type AgentSessionReserveResult
} from './agent-session-reservation-admission'
import type { AgentSessionStoreState } from './agent-session-record-store-file'
import { setAgentSessionTabVisibility, showAgentSessionTabs } from './agent-session-tab-table'
import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { loadAgentSessionStoreRows } from './agent-session-record-rows'
import { AgentSessionStoreTransactions } from './agent-session-store-transactions'

export const AGENT_SESSION_LEASE_TTL_MS = 30_000,
  AGENT_SESSION_LEASE_RENEW_INTERVAL_MS = 10_000

export class AgentSessionRecordStore {
  private readonly deathEvidenceListeners = new Set<(sessionId: string) => void>()
  private readonly firstRecordListeners = new Set<() => void>()

  private constructor(
    private readonly transactions: AgentSessionStoreTransactions,
    readonly hostId: string
  ) {}

  /** Reads every row once; nothing re-reads them. `hostId` is the execution host this runtime is. */
  static open(args: {
    journalDatabase: JournalHostDatabase
    hostId: string
  }): AgentSessionRecordStore {
    const loaded = loadAgentSessionStoreRows(args.journalDatabase.db, args.hostId)
    return new AgentSessionRecordStore(
      new AgentSessionStoreTransactions(args.journalDatabase, loaded),
      args.hostId
    )
  }

  private get state(): AgentSessionStoreState {
    return this.transactions.state
  }

  /** A newer Orca wrote the database: every read answers, and every write is refused. */
  get readOnly(): boolean {
    return this.transactions.readOnly
  }

  getRecord = (sessionId: string): AgentSessionRecord | null =>
    this.state.records.get(sessionId) ?? null

  listRecords = (): AgentSessionRecord[] => [...this.state.records.values()]

  /** Whether this host has recorded a chat, readable or not. Nothing removes a record row. */
  holdsRecords = (): boolean => this.state.records.size > 0 || this.state.unreadableRecords.size > 0

  listVisibleSessionIds = (): string[] =>
    (this.state.sessionTabs?.sessionIds() ?? []).filter((sessionId) =>
      this.state.records.has(sessionId)
    )

  /** Unrecorded, `sessionIds` are the tab rows a chat opened while the import was owed left. */
  getVisibleSessionTabIndex = (): { present: boolean; sessionIds: string[] } => ({
    present: this.state.sessionTabs !== null,
    sessionIds: this.state.sessionTabs
      ? this.listVisibleSessionIds()
      : (this.state.unrecordedSessionTabs?.sessionIds() ?? []).filter((sessionId) =>
          this.state.records.has(sessionId)
        )
  })

  /** The id of the chat tab showing this conversation, if one does. */
  getSessionTabId = (sessionId: string): string | null =>
    this.state.sessionTabs?.tabIdFor(sessionId) ?? null

  /**
   * Persist the user-visible tab reference separately from the rollback-sensitive profile tabs.
   * Showing keeps a tab the session already has; `tabId` puts a hidden one back under its old id.
   */
  setSessionTabVisibility(sessionId: string, visible: boolean, tabId?: string): Promise<void> {
    return this.transact((draft) => setAgentSessionTabVisibility(draft, sessionId, visible, tabId))
  }

  /** Shows each session that still has a record, in one write: an index written part way would
   *  read as complete at the next launch and drop the rest. */
  showSessionTabs(sessionIds: readonly string[]): Promise<void> {
    return this.transact((draft) => showAgentSessionTabs(draft, sessionIds))
  }

  listByScope(location: AgentSessionExecutionLocation): AgentSessionRecord[] {
    const scope = agentSessionScopeKey(location)
    return this.listRecords().filter((record) => agentSessionScopeKey(record.location) === scope)
  }

  setConversationCommand(
    sessionId: string,
    fence: number,
    command: NonNullable<AgentSessionRecord['conversationCommand']>
  ): Promise<void> {
    return this.transact((draft) =>
      commitConversationCommandRecord(draft, sessionId, fence, command)
    )
  }

  /** A committed /clear and the at-rest conversation it continues in, in one write. */
  commitConversationClear = (clear: AgentSessionConversationClear): Promise<void> =>
    this.transact((draft) => commitConversationClearRecord(draft, clear))

  /** Unfenced on purpose: the name is a durable note, so writing it never contends with the
   *  writer lease. `null` clears it. */
  setConversationName = (sessionId: string, name: string | null): Promise<AgentSessionRecord> =>
    this.mutate(sessionId, (record) =>
      setAgentSessionRecordConversationName(record, name, Date.now())
    )

  /** A record this build cannot validate: readable as present, never grantable as a writer. */
  isSessionUnreadable(sessionId: string): boolean {
    return this.state.unreadableRecords.has(sessionId)
  }

  listOperationRows = (): AgentSessionOperationRow[] => [...this.state.operations.values()]

  getOperationRow = (callerKey: string, operationId: string): AgentSessionOperationRow | null =>
    this.state.operations.get(agentSessionOperationKey(callerKey, operationId)) ?? null

  isClaimKeyVerifiable = (keyId: string, now: number): boolean =>
    isAgentSessionClaimKeyVerifiable(this.state, keyId, now)

  async reserveOwner(request: AgentSessionReserveRequest): Promise<AgentSessionReserveResult> {
    return this.transact((draft) =>
      commitAgentSessionReservation(draft, request, AGENT_SESSION_LEASE_TTL_MS)
    )
  }

  async commitProcessIdentity(
    args: AgentSessionProcessIdentityCommit
  ): Promise<AgentSessionRecord> {
    return this.mutate(args.sessionId, (record) =>
      commitAgentSessionProcessIdentity({ ...args, record })
    )
  }

  async proveOwner(args: {
    sessionId: string
    fence: number
    link: AgentSessionProviderHandleLink
    now: number
    leaseTtlMs?: number
    options?: Readonly<Record<string, string>>
  }): Promise<AgentSessionRecord> {
    return this.mutate(args.sessionId, (record) => {
      const proved = proveAgentSessionOwner({
        record,
        fence: args.fence,
        link: args.link,
        now: args.now,
        leaseTtlMs: args.leaseTtlMs ?? AGENT_SESSION_LEASE_TTL_MS
      })
      return args.options
        ? replaceAgentSessionRecordOptions(proved, { ...args, options: args.options })
        : proved
    })
  }

  /** Settle the failed attach and its reservation in one durable transaction. */
  settleFailedAcquisition = (args: AgentSessionFailedAcquisitionSettlement) =>
    this.transact((draft) => settleFailedAgentSessionAcquisition(draft, args))

  settleFailedPostAcquisitionAttachment = (
    args: AgentSessionFailedPostAcquisitionAttachmentSettlement
  ) => this.transact((draft) => settleFailedAgentSessionPostAcquisitionAttachment(draft, args))

  async renewLease(args: AgentSessionLeaseRenewal): Promise<AgentSessionRecord> {
    const [renewed] = await this.renewLeases([args])
    return renewed
  }

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

  async transitionHandoff(
    sessionId: string,
    transition: (record: AgentSessionRecord) => AgentSessionRecord
  ): Promise<AgentSessionRecord> {
    return this.mutate(sessionId, transition)
  }

  /**
   * Adjudicate every lease this host loaded. No lease grants a writer until it appears here. On a
   * database a newer Orca wrote, the verdicts are kept in memory only: they are re-derived at every
   * start, and none grants a writer there, since every grant is a write.
   */
  async reconcileOnRestart(
    args: AgentSessionRestartProbeArgs
  ): Promise<Map<string, AgentSessionRecord>> {
    const pending = this.listRecords().filter((record) => record.lease.unreconciled)
    const probes = await collectAgentSessionRestartProbes(pending, args)
    return this.transact((draft) => applyAgentSessionRestartProbes(draft, probes, args.now), {
      inMemoryWhenReadOnly: true
    })
  }

  /** Admits one non-reservation mutation through the durable ledger. */
  admitOperation = (args: AgentSessionOperationAdmission): Promise<AgentSessionOperationDecision> =>
    this.transact((draft) => admitAgentSessionOperationInto(draft, args))

  /** Send ids stay global after a caller reconnects under a different identity. */
  admitGlobalOperation = (
    args: AgentSessionOperationAdmission
  ): Promise<AgentSessionOperationDecision> =>
    this.transact((draft) => admitAgentSessionGlobalOperationInto(draft, args))

  admitMutationOperation = (args: AgentSessionMutationOperationAdmission) =>
    this.transact((draft) => admitAgentSessionMutationOperation(draft, args))

  /** The ledger's answer alone, placing nothing; `admitMutationOperation` is the transaction. */
  evaluateMutationOperation = (args: AgentSessionMutationOperationAdmission) =>
    evaluateAgentSessionMutationOperation(this.state, args)

  /** Durable compare-and-swap for the right to run an admitted operation's effect: two replays both
   *  read `pending`, and only a conditional swap tells the one that may run from the one that must
   *  replay. */
  claimOperation = (args: {
    callerKey: string
    operationId: string
  }): Promise<AgentSessionOperationClaim> =>
    this.transact((draft) => claimAgentSessionOperationInto(draft, args))

  async recordOperationOutcome(args: {
    callerKey?: string
    operationId: string
    outcome: AgentSessionOperationOutcome
  }): Promise<void> {
    await this.transact((draft) => settleAgentSessionOperationInto(draft, args))
  }

  replaceSessionOptions = (args: AgentSessionOptionsReplacement): Promise<AgentSessionRecord> =>
    this.mutate(args.sessionId, (record) => replaceAgentSessionRecordOptions(record, args))

  async retireClaimKey(keyId: string, now: number): Promise<void> {
    await this.transact((draft) => retireAgentSessionClaimKey(draft, keyId, now))
  }

  private async mutate(
    sessionId: string,
    apply: (record: AgentSessionRecord) => AgentSessionRecord
  ): Promise<AgentSessionRecord> {
    return this.transact((draft) => {
      const record = draft.records.get(sessionId)
      if (!record) {
        throw draft.unreadableRecords.has(sessionId)
          ? agentSessionRefusalError('execution_owner_reconciling', { reason: 'recordUnreadable' })
          : agentSessionRefusalError('agent_session_identity_required', { reason: 'recordMissing' })
      }
      const next = apply(record)
      draft.records.set(sessionId, next)
      return next
    })
  }

  /** Told, once committed, of each session a transaction wrote a proof of death for — whichever
   *  transition wrote it, since every one lands here. Must not throw. */
  onDeathEvidence(listener: (sessionId: string) => void): () => void {
    this.deathEvidenceListeners.add(listener)
    return () => this.deathEvidenceListeners.delete(listener)
  }

  /** Told, once committed, when the store records its first chat. Must not throw. */
  onFirstRecord(listener: () => void): () => void {
    this.firstRecordListeners.add(listener)
    return () => this.firstRecordListeners.delete(listener)
  }

  /** Serializes every mutation. `apply` changes only the draft it is given; readers see the change
   *  once its rows have committed. */
  private transact = async <T>(
    apply: (draft: AgentSessionStoreState) => T,
    options?: { inMemoryWhenReadOnly?: boolean }
  ): Promise<T> => {
    let proven: string[] = []
    let heldBefore = true
    const result = await this.transactions.transact((draft) => {
      heldBefore = this.holdsRecords()
      if (this.deathEvidenceListeners.size === 0) {
        return apply(draft)
      }
      const before = new Map(
        [...draft.records].map(([id, record]) => [id, record.lease.deathEvidence])
      )
      const applied = apply(draft)
      proven = [...draft.records]
        .filter(([id, { lease }]) => lease.deathEvidence && lease.deathEvidence !== before.get(id))
        .map(([id]) => id)
      return applied
    }, options)
    for (const sessionId of proven) {
      this.deathEvidenceListeners.forEach((listener) => listener(sessionId))
    }
    if (!heldBefore && this.holdsRecords()) {
      this.firstRecordListeners.forEach((listener) => listener())
    }
    return result
  }
}
