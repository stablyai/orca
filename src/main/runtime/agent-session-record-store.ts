/** Durable single-writer session records and their operation ledger, as rows in the host's chat
 *  journal database. */

import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import { createAgentSessionConversationReceipts } from './agent-session-conversation-receipts'
import { commitConversationCommandRecord } from './agent-session-conversation-command-record'
import { pinAgentSessionRecordLaunchDirectory } from './agent-session-record-launch-directory'
import {
  agentSessionOperationKey,
  type AgentSessionOperationClaim,
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
  type AgentSessionProcessIdentity,
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
import { heldAgentSessionIds, type AgentSessionStoreState } from './agent-session-store-state'
import {
  agentSessionVisibleTabIndex,
  listVisibleAgentSessionIds,
  setAgentSessionTabVisibility,
  showAgentSessionTabs
} from './agent-session-tab-table'
import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import type { JournalOperationReceipt } from '../native-chat/agent-session-journal/journal-row-writer'
import { loadAgentSessionStoreRows } from './agent-session-record-rows'
import { AgentSessionStoreTransactions } from './agent-session-store-transactions'
import {
  compareAndSetAgentSessionRecordName,
  type CompareAndSetConversationName,
  setAgentSessionRecordConversationName
} from './agent-session-record-conversation-name'
import {
  agentSessionClosedOwnerKey,
  type AgentSessionClosedOwner
} from './agent-session-closed-owner'
import { AgentSessionStoreNotifications } from './agent-session-store-notifications'
import { assertAgentSessionProbedOwner } from './agent-session-reconciliation-target'

type AgentSessionOperationSettlement = Parameters<typeof settleAgentSessionOperationInto>[1]

export const AGENT_SESSION_LEASE_TTL_MS = 30_000,
  AGENT_SESSION_LEASE_RENEW_INTERVAL_MS = 10_000

export class AgentSessionRecordStore {
  private readonly notifications = new AgentSessionStoreNotifications()
  readonly conversationReceipts: ReturnType<typeof createAgentSessionConversationReceipts>

  private constructor(
    private readonly transactions: AgentSessionStoreTransactions,
    readonly hostId: string
  ) {
    this.conversationReceipts = createAgentSessionConversationReceipts(transactions)
  }

  /** Reads every structurally valid row, independently of which agents this host can start. */
  static open(args: {
    journalDatabase: JournalHostDatabase
    hostId: string
  }): AgentSessionRecordStore {
    const rows = loadAgentSessionStoreRows(args.journalDatabase.db)
    const transactions = new AgentSessionStoreTransactions(args.journalDatabase, rows)
    return new AgentSessionRecordStore(transactions, args.hostId)
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

  closedOwners = (sessionId: string): AgentSessionClosedOwner[] =>
    [...this.state.closedOwners.values()]
      .filter((fact) => fact.sessionId === sessionId)
      .sort((left, right) => left.deadOwnerFence - right.deadOwnerFence)

  /** Every chat this host holds a row for, readable or not. */
  listHeldSessionIds = (): string[] => heldAgentSessionIds(this.state)

  /** Whether this host has recorded a chat, readable or not. Nothing removes a record row. */
  holdsRecords = (): boolean => this.state.records.size > 0 || this.state.unreadableRecords.size > 0

  listVisibleSessionIds = (): string[] => listVisibleAgentSessionIds(this.state)

  getVisibleSessionTabIndex = (): { present: boolean; sessionIds: string[] } =>
    agentSessionVisibleTabIndex(this.state)

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

  /** Unfenced on purpose: the name is a durable note, so writing it never contends with the
   *  writer lease. `null` clears it. */
  setConversationName = (sessionId: string, name: string | null): Promise<AgentSessionRecord> =>
    this.mutate(sessionId, (record) =>
      setAgentSessionRecordConversationName(record, name, Date.now())
    )

  compareAndSetConversationName: CompareAndSetConversationName = (sessionId, name, expected) =>
    compareAndSetAgentSessionRecordName((apply) => this.mutate(sessionId, apply), name, expected)

  /** Unfenced like the name: it records where a launch ran and never contends with the lease. */
  pinLaunchDirectory = (sessionId: string, launchDirectory: string): Promise<AgentSessionRecord> =>
    this.mutate(sessionId, (record) =>
      pinAgentSessionRecordLaunchDirectory(record, launchDirectory, Date.now())
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

  commitProcessIdentity = (args: AgentSessionProcessIdentityCommit): Promise<AgentSessionRecord> =>
    this.mutate(args.sessionId, (record) => commitAgentSessionProcessIdentity({ ...args, record }))

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
    probedOwner?: AgentSessionProcessIdentity | null
    now: number
  }): Promise<AgentSessionRecord> {
    return this.mutate(args.sessionId, (record) => {
      assertAgentSessionProbedOwner(record, args.probedOwner)
      return evictAgentSessionOwner({ ...args, record })
    })
  }

  async transitionHandoff(
    sessionId: string,
    transition: (record: AgentSessionRecord) => AgentSessionRecord
  ): Promise<AgentSessionRecord> {
    return this.mutate(sessionId, transition)
  }

  /**
   * Adjudicate loaded leases, or only the addressed session. No lease grants a writer until it
   * appears here. On a newer database, verdicts stay in memory only: they are re-derived at every
   * start, and none grants a writer there, since every grant is a write.
   */
  async reconcileOnRestart(
    args: AgentSessionRestartProbeArgs
  ): Promise<Map<string, AgentSessionRecord>> {
    const probes = await collectAgentSessionRestartProbes(this, args)
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

  /** Admission and, when `claimAfter` allows, the claim: one durable write before the effect. */
  admitAndClaimOperation = (
    args: Parameters<typeof admitAndClaimAgentSessionOperationInto>[1],
    claimAfter: ClaimAfterAdmission
  ) => this.transact((draft) => admitAndClaimAgentSessionOperationInto(draft, args, claimAfter))

  async recordOperationOutcome(args: AgentSessionOperationSettlement): Promise<void> {
    await this.transact((draft) => settleAgentSessionOperationInto(draft, args))
  }

  /** The same settlement, committed by the journal write that makes it true. It changes only the
   *  ledger, so no record listener is owed. */
  operationOutcomeReceipt = (args: AgentSessionOperationSettlement): JournalOperationReceipt =>
    this.transactions.receipt((draft) => settleAgentSessionOperationInto(draft, args))

  /** Retires a closed owner in the same transaction as the journal write that settles its work. */
  closedOwnerReceipt = (fact: AgentSessionClosedOwner): JournalOperationReceipt =>
    this.transactions.receipt((draft) => {
      draft.closedOwners.delete(agentSessionClosedOwnerKey(fact))
    })

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

  /** Existing proof notifications carry the committed fact without changing their timing. */
  onDeathEvidence = this.notifications.onDeathEvidence

  /** Includes fresh reservation proofs as well as every other committed closure. */
  onClosedOwner = this.notifications.onClosedOwner

  onFirstRecord = this.notifications.onFirstRecord

  private transact = async <T>(
    apply: (draft: AgentSessionStoreState) => T,
    options?: { inMemoryWhenReadOnly?: boolean }
  ): Promise<T> => {
    let publish: (durable: boolean) => void = () => {}
    const result = await this.transactions.transact((draft) => {
      const staged = this.notifications.stage(draft, apply)
      publish = staged.publish
      return staged.result
    }, options)
    publish(!this.readOnly)
    return result
  }
}
