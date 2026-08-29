/** Durable single-writer session records and their operation ledger. */

import {
  agentSessionOperationKey,
  settleAgentSessionOperation,
  type AgentSessionOperationDecision,
  type AgentSessionOperationOutcome,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import {
  admitAgentSessionOperationRow,
  type AgentSessionOperationAdmission
} from './agent-session-operation-admission'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import { classifyObservedAgentSessionSpawnToken } from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import {
  agentSessionScopeKey,
  type AgentSessionExecutionLocation,
  type AgentSessionJournalCheckpoint,
  type AgentSessionOptionsReplacement,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
import {
  commitAgentSessionProcessIdentity,
  evictAgentSessionOwner,
  proveAgentSessionOwner,
  setAgentSessionJournalCheckpoint,
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
  setAgentSessionReservationProcesslessProof,
  type AgentSessionReservationProcesslessProof
} from './agent-session-processless-reservation'
import {
  admitPendingAgentSessionReservationReplay,
  applyAgentSessionReservation,
  evaluateAgentSessionReserveOperation,
  requireAgentSessionRecordForReplay,
  type AgentSessionReserveRequest,
  type AgentSessionReserveResult
} from './agent-session-reservation-admission'
import {
  agentSessionStoreRevision,
  agentSessionStorePath,
  type AgentSessionStoreState
} from './agent-session-record-store-file'
import { loadProtectedAgentSessionStore } from './agent-session-record-store-security'
import {
  AgentSessionStoreTransactionQueue,
  markAgentSessionStoreLeasesUnreconciled
} from './agent-session-store-transaction-queue'

export const AGENT_SESSION_LEASE_TTL_MS = 30_000,
  AGENT_SESSION_LEASE_RENEW_INTERVAL_MS = 10_000
/** Retired claim keys stay verifiable this long so a rotation cannot strand a running agent. */
export const AGENT_SESSION_CLAIM_KEY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export class AgentSessionRecordStore {
  private constructor(private readonly transactions: AgentSessionStoreTransactionQueue) {}

  static async open(args: { directory: string; hostId: string }): Promise<AgentSessionRecordStore> {
    const filePath = agentSessionStorePath(args.directory)
    const loaded = await loadProtectedAgentSessionStore(filePath, args.hostId)
    // Why: every persisted lease is unreconciled until this host adjudicates it, so a restart
    // grants no writer on the strength of what the previous process wrote.
    const diskRevision = agentSessionStoreRevision(loaded.state)
    markAgentSessionStoreLeasesUnreconciled(loaded.state)
    const transactions = AgentSessionStoreTransactionQueue.fromLoadedStore(
      filePath,
      args.hostId,
      loaded,
      diskRevision
    )
    if (loaded.needsRewrite && !loaded.readOnly && !loaded.recoveredFromBackup) {
      await transactions.persistLoadedRewrite()
    }
    return new AgentSessionRecordStore(transactions)
  }

  private get state(): AgentSessionStoreState {
    return this.transactions.state
  }

  get readOnly(): boolean {
    return this.transactions.readOnly
  }

  get recoveredFromBackup(): boolean {
    return this.transactions.recoveredFromBackup
  }

  get hostId(): string {
    return this.state.hostId
  }

  getRecord = (sessionId: string): AgentSessionRecord | null =>
    this.state.records.get(sessionId) ?? null

  listRecords = (): AgentSessionRecord[] => [...this.state.records.values()]

  listByScope(location: AgentSessionExecutionLocation): AgentSessionRecord[] {
    const scope = agentSessionScopeKey(location)
    return this.listRecords().filter((record) => agentSessionScopeKey(record.location) === scope)
  }

  /** A record this build cannot validate: readable as present, never grantable as a writer. */
  isSessionUnreadable(sessionId: string): boolean {
    return this.state.unreadableRecords.has(sessionId)
  }

  listOperationRows = (): AgentSessionOperationRow[] => [...this.state.operations.values()]

  isClaimKeyVerifiable(keyId: string, now: number): boolean {
    const retired = this.state.retiredClaimKeys.find((entry) => entry.keyId === keyId)
    return !retired || now - retired.retiredAt <= AGENT_SESSION_CLAIM_KEY_RETENTION_MS
  }

  /** Spawn tokens observed on the host with no matching lease. Stop them; never adopt them. */
  listOrphanSpawnTokens(observedTokens: readonly string[]): string[] {
    const leases = this.listRecords().map((record) => record.lease)
    return observedTokens.filter(
      (spawnToken) => classifyObservedAgentSessionSpawnToken({ spawnToken, leases }) === 'orphan'
    )
  }

  /**
   * Compare-and-swap reservation plus its client-operation row, committed together. A replayed
   * operation returns the recorded outcome and never reaches the reservation.
   */
  async reserveOwner(request: AgentSessionReserveRequest): Promise<AgentSessionReserveResult> {
    return this.transact(() => {
      const decision = evaluateAgentSessionReserveOperation(this.state, request)
      if (decision.decision === 'refused') {
        throw new Error(decision.code)
      }
      if (decision.decision === 'replay') {
        let record = requireAgentSessionRecordForReplay(this.state, decision.row, request.sessionId)
        if (decision.row.outcome.status === 'pending' && request.handoffOperationId !== null) {
          record = admitPendingAgentSessionReservationReplay(record, request)
        }
        return { record, disposition: 'replayed' as const, operationRow: decision.row }
      }
      const result = applyAgentSessionReservation(this.state, request, AGENT_SESSION_LEASE_TTL_MS)
      this.state.operations.set(
        agentSessionOperationKey(request.operation.callerKey, request.operation.operationId),
        decision.row
      )
      this.state.records.set(result.record.sessionId, result.record)
      return { ...result, operationRow: decision.row }
    })
  }

  async commitProcessIdentity(
    args: AgentSessionProcessIdentityCommit
  ): Promise<AgentSessionRecord> {
    return this.mutate(args.sessionId, (record) =>
      commitAgentSessionProcessIdentity({ ...args, record })
    )
  }

  setReservationProcesslessProof = (
    args: AgentSessionReservationProcesslessProof & { processlessAt: number | null }
  ): Promise<AgentSessionRecord> =>
    this.mutate(args.sessionId, (record) =>
      setAgentSessionReservationProcesslessProof({ ...args, record })
    )

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
    this.transact(() => settleFailedAgentSessionAcquisition(this.state, args))

  settleFailedPostAcquisitionAttachment = (
    args: AgentSessionFailedPostAcquisitionAttachmentSettlement
  ) => this.transact(() => settleFailedAgentSessionPostAcquisitionAttachment(this.state, args))

  async renewLease(args: AgentSessionLeaseRenewal): Promise<AgentSessionRecord> {
    const [renewed] = await this.renewLeases([args])
    return renewed
  }

  async renewLeases(renewals: readonly AgentSessionLeaseRenewal[]): Promise<AgentSessionRecord[]> {
    return this.transact(() =>
      renewAgentSessionLeases(this.state, renewals, AGENT_SESSION_LEASE_TTL_MS)
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

  async setJournalCheckpoint(args: {
    sessionId: string
    fence: number
    checkpoint: AgentSessionJournalCheckpoint
    now: number
  }): Promise<AgentSessionRecord> {
    return this.mutate(args.sessionId, (record) =>
      setAgentSessionJournalCheckpoint({ ...args, record })
    )
  }

  /** Adjudicate every lease this host loaded. No lease grants a writer until it appears here. */
  async reconcileOnRestart(
    args: AgentSessionRestartProbeArgs
  ): Promise<Map<string, AgentSessionRecord>> {
    const pending = this.listRecords().filter((record) => record.lease.unreconciled)
    const probes = await collectAgentSessionRestartProbes(pending, args)
    return this.transact(() => applyAgentSessionRestartProbes(this.state, probes, args.now))
  }

  /** Admits one non-reservation mutation through the durable ledger. */
  async admitOperation(
    args: AgentSessionOperationAdmission
  ): Promise<AgentSessionOperationDecision> {
    return this.transact(() => {
      const admitted = admitAgentSessionOperationRow(this.state.operations, args)
      this.state.operations = admitted.rows
      return admitted.decision
    })
  }

  async recordOperationOutcome(args: {
    callerKey?: string
    operationId: string
    outcome: AgentSessionOperationOutcome
  }): Promise<void> {
    await this.transact(() => {
      this.state.operations = settleAgentSessionOperation(this.state.operations, args)
    })
  }

  async markClaimConflicted(sessionId: string, now: number): Promise<AgentSessionRecord> {
    return this.mutate(sessionId, (record) => ({
      ...record,
      updatedAt: now,
      // Why: a conflicted key must stay conflicted across a restart; it cannot resolve to free
      // merely because the process that observed the conflict is gone.
      lease: { ...record.lease, claimStatus: 'conflicted', handoffStage: 'manual-recovery' }
    }))
  }

  replaceSessionOptions = (args: AgentSessionOptionsReplacement): Promise<AgentSessionRecord> =>
    this.mutate(args.sessionId, (record) => replaceAgentSessionRecordOptions(record, args))

  async retireClaimKey(keyId: string, now: number): Promise<void> {
    await this.transact(() => {
      if (!this.state.retiredClaimKeys.some((entry) => entry.keyId === keyId)) {
        this.state.retiredClaimKeys.push({ keyId, retiredAt: now })
      }
      this.state.retiredClaimKeys = this.state.retiredClaimKeys.filter(
        (entry) => now - entry.retiredAt <= AGENT_SESSION_CLAIM_KEY_RETENTION_MS
      )
    })
  }

  private async mutate(
    sessionId: string,
    apply: (record: AgentSessionRecord) => AgentSessionRecord
  ): Promise<AgentSessionRecord> {
    return this.transact(() => {
      const record = this.state.records.get(sessionId)
      if (!record) {
        throw new Error(
          this.isSessionUnreadable(sessionId)
            ? 'execution_owner_reconciling'
            : 'agent_session_identity_required'
        )
      }
      const next = apply(record)
      this.state.records.set(sessionId, next)
      return next
    })
  }

  /** Serialize every mutation against the latest committed disk state. */
  private transact = <T>(apply: () => T): Promise<T> => this.transactions.transact(apply)
}
