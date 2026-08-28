/**
 * Durable agent-session store for one execution host.
 *
 * Holds the session records, their single-writer leases, and the client-operation ledger that
 * used to live only in memory — all in one file so a reservation and its operation row commit in
 * the same atomic transaction. Mutations are serialized through a single write queue, so two
 * concurrent compare-and-swaps in one or multiple Orca processes cannot both commit one pre-state.
 *
 * Nothing here is wired into the runtime yet; the store is dormant until later parts adopt it.
 */

import {
  pruneAgentSessionOperationRows,
  agentSessionOperationKey,
  type AgentSessionOperationOutcome,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import { classifyObservedAgentSessionSpawnToken } from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import {
  agentSessionScopeKey,
  type AgentSessionExecutionLocation,
  type AgentSessionHandoffStage,
  type AgentSessionJournalCheckpoint,
  type AgentSessionProcessIdentity,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
import {
  applyAgentSessionRestartAdjudication,
  agentSessionReconciliationTargetMatches,
  commitAgentSessionProcessIdentity,
  evictAgentSessionOwner,
  proveAgentSessionOwner,
  renewAgentSessionLease,
  setAgentSessionHandoffStage,
  setAgentSessionJournalCheckpoint
} from './agent-session-lease-transitions'
import {
  applyAgentSessionReservation,
  evaluateAgentSessionReserveOperation,
  requireAgentSessionRecordForReplay,
  type AgentSessionReserveRequest,
  type AgentSessionReserveResult
} from './agent-session-reservation-admission'
import {
  agentSessionStoreRevision,
  agentSessionStorePath,
  loadAgentSessionStore,
  type AgentSessionStoreState
} from './agent-session-record-store-file'
import {
  AgentSessionStoreTransactionQueue,
  markAgentSessionStoreLeasesUnreconciled
} from './agent-session-store-transaction-queue'

export type {
  AgentSessionReserveRequest,
  AgentSessionReserveResult
} from './agent-session-reservation-admission'

export const AGENT_SESSION_LEASE_TTL_MS = 30_000
export const AGENT_SESSION_LEASE_RENEW_INTERVAL_MS = 10_000
/** Retired claim keys stay verifiable this long so a rotation cannot strand a running agent. */
export const AGENT_SESSION_CLAIM_KEY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export class AgentSessionRecordStore {
  private constructor(private readonly transactions: AgentSessionStoreTransactionQueue) {}

  static async open(args: { directory: string; hostId: string }): Promise<AgentSessionRecordStore> {
    const filePath = agentSessionStorePath(args.directory)
    const loaded = await loadAgentSessionStore(filePath, args.hostId)
    // Why: every persisted lease is unreconciled until this host adjudicates it, so a restart
    // grants no writer on the strength of what the previous process wrote.
    const diskRevision = agentSessionStoreRevision(loaded.state)
    markAgentSessionStoreLeasesUnreconciled(loaded.state)
    return new AgentSessionRecordStore(
      new AgentSessionStoreTransactionQueue(
        filePath,
        args.hostId,
        loaded.readOnly,
        loaded.recoveredFromBackup,
        loaded.storeFound,
        loaded.state,
        diskRevision
      )
    )
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

  getRecord(sessionId: string): AgentSessionRecord | null {
    return this.state.records.get(sessionId) ?? null
  }

  listRecords(): AgentSessionRecord[] {
    return [...this.state.records.values()]
  }

  listByScope(location: AgentSessionExecutionLocation): AgentSessionRecord[] {
    const scope = agentSessionScopeKey(location)
    return this.listRecords().filter((record) => agentSessionScopeKey(record.location) === scope)
  }

  /** A record this build cannot validate: readable as present, never grantable as a writer. */
  isSessionUnreadable(sessionId: string): boolean {
    return this.state.unreadableRecords.has(sessionId)
  }

  listOperationRows(): AgentSessionOperationRow[] {
    return [...this.state.operations.values()]
  }

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
        const record = requireAgentSessionRecordForReplay(
          this.state,
          decision.row,
          request.sessionId
        )
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

  async commitProcessIdentity(args: {
    sessionId: string
    fence: number
    process: AgentSessionProcessIdentity
    now: number
  }): Promise<AgentSessionRecord> {
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
  }): Promise<AgentSessionRecord> {
    return this.mutate(args.sessionId, (record) =>
      proveAgentSessionOwner({
        record,
        fence: args.fence,
        link: args.link,
        now: args.now,
        leaseTtlMs: args.leaseTtlMs ?? AGENT_SESSION_LEASE_TTL_MS
      })
    )
  }

  async renewLease(args: {
    sessionId: string
    fence: number
    childProbe: AgentSessionOwnerProbe
    now: number
    leaseTtlMs?: number
  }): Promise<AgentSessionRecord> {
    return this.mutate(args.sessionId, (record) =>
      renewAgentSessionLease({
        record,
        fence: args.fence,
        childProbe: args.childProbe,
        now: args.now,
        leaseTtlMs: args.leaseTtlMs ?? AGENT_SESSION_LEASE_TTL_MS
      })
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

  async setHandoffStage(args: {
    sessionId: string
    fence: number
    stage: AgentSessionHandoffStage | null
    handoffOperationId: string | null
    now: number
  }): Promise<AgentSessionRecord> {
    return this.mutate(args.sessionId, (record) => setAgentSessionHandoffStage({ ...args, record }))
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
  async reconcileOnRestart(args: {
    probe: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
    now: number
  }): Promise<Map<string, AgentSessionRecord>> {
    const pending = this.listRecords().filter((record) => record.lease.unreconciled)
    const probes = new Map<string, { record: AgentSessionRecord; probe: AgentSessionOwnerProbe }>()
    for (const record of pending) {
      probes.set(record.sessionId, { record, probe: await args.probe(record) })
    }
    return this.transact(() => {
      const reconciled = new Map<string, AgentSessionRecord>()
      for (const [sessionId, probed] of probes) {
        const record = this.state.records.get(sessionId)
        if (
          !record?.lease.unreconciled ||
          !agentSessionReconciliationTargetMatches(record, probed.record)
        ) {
          continue
        }
        const next = applyAgentSessionRestartAdjudication({
          record,
          probe: probed.probe,
          now: args.now
        })
        this.state.records.set(sessionId, next)
        reconciled.set(sessionId, next)
      }
      this.state.operations = pruneAgentSessionOperationRows(this.state.operations, args.now)
      return reconciled
    })
  }

  async recordOperationOutcome(args: {
    callerKey: string
    operationId: string
    outcome: AgentSessionOperationOutcome
  }): Promise<void> {
    await this.transact(() => {
      const key = agentSessionOperationKey(args.callerKey, args.operationId)
      const row = this.state.operations.get(key)
      if (row) {
        this.state.operations.set(key, { ...row, outcome: args.outcome })
      }
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
  private async transact<T>(apply: () => T): Promise<T> {
    return this.transactions.transact(apply)
  }
}
