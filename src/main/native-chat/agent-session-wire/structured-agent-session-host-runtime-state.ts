import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import {
  deriveAgentSessionLeaseState,
  type AgentSessionHostProof,
  type AgentSessionLeaseState
} from '../../../shared/agent-session-lease-state'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionFailedAcquisitionSettlement } from '../../runtime/agent-session-acquisition-failure-settlement'
import {
  createDeferredStructuredAgentSessionEventSink,
  type DeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionSinkBarrier
} from './structured-agent-session-event-sink'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { StructuredAgentSessionLeaseRenewer } from './structured-agent-session-lease-renewer'
import { structuredAgentSessionOwnerProof } from './structured-agent-session-owner-proof'
import { resolveStructuredSessionRecovery } from './structured-agent-session-recovery-resolution'

/** The host's own memory of its sessions, which owner proof is read from. */
export type StructuredAgentSessionHostMemory = {
  session: (sessionId: string) => StructuredAgentSessionHostSession | undefined
  serialize: (sessionId: string, task: () => Promise<void>) => Promise<void>
}

export class StructuredAgentSessionHostRuntimeState {
  private readonly eventSinks = new Map<string, DeferredStructuredAgentSessionEventSink>()
  /** Sessions an attach of this host's is acquiring. In memory only: a restart reconciles every
   *  lease anyway, and an attempt that ends takes its entry with it. */
  private readonly acquisitions = new Set<string>()
  /** Each session's last failed attempt whose settlement write did not land: the proof that frees
   *  its reservation, and the write the renewer replays. Dead once the lease moves past its fence. */
  private readonly unsettledAcquisitions = new Map<
    string,
    AgentSessionFailedAcquisitionSettlement
  >()
  private readonly leaseRenewer: StructuredAgentSessionLeaseRenewer
  private readonly onEventSinkFailure?: (sessionId: string, error: unknown) => void

  constructor(
    private readonly deps: StructuredAgentSessionHostDeps,
    private readonly memory: StructuredAgentSessionHostMemory,
    onEventSinkFailure?: (sessionId: string, error: unknown) => void
  ) {
    this.onEventSinkFailure = onEventSinkFailure
    this.leaseRenewer = new StructuredAgentSessionLeaseRenewer({
      store: deps.store,
      probe: (record) => this.probeRecord(record),
      ...(deps.probeOwners ? { probeMany: deps.probeOwners } : {}),
      ownerProof: (record) => this.ownerProofFor(record),
      landUnsettledAcquisition: (sessionId) => this.landUnsettledAcquisition(sessionId),
      serialize: memory.serialize,
      now: () => deps.now?.() ?? Date.now(),
      // Lease/ownership failures are transient and stay on the visible lease-error path.
      // Only deferred sink I/O failures are terminal and may force-close a provider.
      logger: deps.logger
    })
  }

  startLeaseRenewal(): void {
    this.leaseRenewer.start()
  }

  /** Resolves once a renewal tick already in flight has finished writing. */
  stopLeaseRenewal(): Promise<void> {
    return this.leaseRenewer.stop()
  }

  /** The sink the session's current child writes through, created on first use. */
  eventSinkFor(sessionId: string): DeferredStructuredAgentSessionEventSink {
    const existing = this.currentEventSink(sessionId)
    if (existing) {
      return existing
    }
    const created = this.mintEventSink(sessionId)
    this.eventSinks.set(sessionId, created)
    return created
  }

  /** The session's sink, if it has a usable one. A failed sink is terminal: reusing it would make
   *  `drained()` return the old error forever, so it is dropped here instead. */
  currentEventSink(sessionId: string): DeferredStructuredAgentSessionEventSink | undefined {
    const existing = this.eventSinks.get(sessionId)
    if (existing?.state().failed) {
      existing.close()
      this.eventSinks.delete(sessionId)
      return undefined
    }
    return existing
  }

  /** A sink owned by one attach attempt. Uncached until `adoptEventSink`, so an attempt that fails
   *  takes its queue with it rather than leaving it for the next attach to drain. */
  mintEventSink(sessionId: string): DeferredStructuredAgentSessionEventSink {
    const minted: DeferredStructuredAgentSessionEventSink =
      createDeferredStructuredAgentSessionEventSink({
        sessionId,
        logger: this.deps.logger,
        onFailed: (error) => {
          // Only the session's own sink may force its provider down; an attempt's never is.
          if (this.eventSinks.get(sessionId) === minted) {
            this.onEventSinkFailure?.(sessionId, error)
          }
        }
      })
    return minted
  }

  /** The attempt's sink now serves the session; the one it replaces is closed. */
  adoptEventSink(sessionId: string, sink: DeferredStructuredAgentSessionEventSink): void {
    const replaced = this.eventSinks.get(sessionId)
    if (replaced && replaced !== sink) {
      replaced.close()
    }
    this.eventSinks.set(sessionId, sink)
  }

  discardEventSink(sessionId: string): void {
    this.eventSinks.delete(sessionId)
  }

  flushEventSink(sessionId: string): Promise<void> {
    return this.requireSuccessfulBarrier(
      this.eventSinks.get(sessionId)?.drained() ?? Promise.resolve({ ok: true } as const)
    )
  }

  lifecycleBarrier(sessionId: string): Promise<StructuredAgentSessionSinkBarrier> {
    return this.eventSinks.get(sessionId)?.lifecycleBarrier() ?? Promise.resolve({ ok: true })
  }

  async flushAllEventSinks(): Promise<void> {
    await Promise.all(
      [...this.eventSinks.values()].map((sink) => this.requireSuccessfulBarrier(sink.drained()))
    )
  }

  private async requireSuccessfulBarrier(
    barrier: Promise<StructuredAgentSessionSinkBarrier>
  ): Promise<void> {
    const result = await barrier
    if (!result.ok) {
      throw result.error
    }
  }

  /** Exit from a latched recovery stage when present-time evidence permits one. A failed attempt's
   *  unwritten settlement that would have parked its owner there lands first, so recovery concludes
   *  about it as if it had been written. */
  async resolveRecovery(sessionId: string): Promise<'resolved' | 'unresolved' | 'not-applicable'> {
    if (this.leaseState(sessionId)?.state === 'recovering') {
      await this.landUnsettledAcquisition(sessionId).catch((error: unknown) => {
        this.deps.logger.warn("writing a failed start's settlement failed", {
          scope: 'lease-convergence',
          sessionId,
          error
        })
      })
    }
    return resolveStructuredSessionRecovery(
      {
        store: this.deps.store,
        probeRecord: (record) => this.probeRecord(record),
        now: () => this.deps.now?.() ?? Date.now(),
        ...(this.deps.stopOwnerProcess ? { stopOwnerProcess: this.deps.stopOwnerProcess } : {})
      },
      sessionId
    )
  }

  /** Brackets one acquisition. Until it ends, readers outside the session's serialize derive the
   *  lease as `acquiring`; an attach runs under serialize, so there is at most one per session. */
  beginAcquisition(sessionId: string): () => void {
    this.acquisitions.add(sessionId)
    return () => this.acquisitions.delete(sessionId)
  }

  rememberUnsettledAcquisition(settlement: AgentSessionFailedAcquisitionSettlement): void {
    this.unsettledAcquisitions.set(settlement.sessionId, settlement)
  }

  /** Writes the settlement this host's failed attempt could not, while it still speaks for the
   *  lease. An aged-out ledger row already answers its replay as expired, so it is left alone. */
  async landUnsettledAcquisition(sessionId: string): Promise<void> {
    const settlement = this.unsettledAcquisitions.get(sessionId)
    const record = this.deps.store.getRecord(sessionId)
    if (!settlement || !record) {
      return
    }
    const proof = this.ownerProofFor(record)
    const operation = this.deps.store.getOperationRow(settlement.callerKey, settlement.operationId)
    if (
      !proof.attemptInFlight &&
      proof.owner.kind === 'failed-acquisition' &&
      operation?.outcome.status === 'pending'
    ) {
      await this.deps.store.settleFailedAcquisition(settlement)
    }
  }

  /** What memory proves about the session's owner; null when the session has no record. */
  ownerProof(sessionId: string): AgentSessionHostProof | null {
    const record = this.deps.store.getRecord(sessionId)
    return record ? this.ownerProofFor(record) : null
  }

  ownerProofFor(record: AgentSessionRecord): AgentSessionHostProof {
    return {
      ...this.ownerProofForAttempt(record),
      attemptInFlight: this.acquisitions.has(record.sessionId)
    }
  }

  /** The proof as the acquiring attempt itself reads it: its own attempt is not one beside it. */
  ownerProofForAttempt(record: AgentSessionRecord): AgentSessionHostProof {
    const unsettled = this.unsettledAcquisitions.get(record.sessionId)
    // Fences only grow, so an attempt behind the lease can never speak for it again.
    if (unsettled && unsettled.fence < record.lease.runtimeFence) {
      this.unsettledAcquisitions.delete(record.sessionId)
    }
    return structuredAgentSessionOwnerProof({
      lease: record.lease,
      hostId: this.deps.store.hostId,
      session: this.memory.session(record.sessionId),
      attemptInFlight: false,
      ...(unsettled ? { unsettledAcquisition: unsettled } : {})
    })
  }

  /** The lease as memory proves it, for a reader that cannot wait on a probe. A create in flight
   *  has no record yet and is `acquiring` all the same; null when there is neither. */
  leaseState(sessionId: string): AgentSessionLeaseState | null {
    const record = this.deps.store.getRecord(sessionId)
    if (!record) {
      return this.acquisitions.has(sessionId) ? { state: 'acquiring' } : null
    }
    return deriveAgentSessionLeaseState(record.lease, this.ownerProofFor(record))
  }

  /** Memory's proof, or a probe where memory has none: what a start and an acquisition decide on. */
  async proveOwner(sessionId: string): Promise<AgentSessionHostProof | null> {
    const known = this.ownerProof(sessionId)
    if (
      !known ||
      known.attemptInFlight ||
      known.owner.kind === 'watched-exit' ||
      known.owner.kind === 'failed-acquisition'
    ) {
      return known
    }
    return { ...known, owner: { kind: 'probed', probe: await this.probeOwner(sessionId) } }
  }

  probeOwner(sessionId: string): Promise<AgentSessionOwnerProbe> {
    const record = this.deps.store.getRecord(sessionId)
    if (
      !record ||
      (record.lease.ownerProcess === null && record.lease.claimStatus !== 'reserved')
    ) {
      // Acquisition only consults the probe against a recorded owner or a live reservation.
      return Promise.resolve({ outcome: 'reservation-unused' })
    }
    // A live reservation goes through the strict probe: calling it unused without its
    // processless proof is the answer that mints a second writer.
    return this.probeRecord(record)
  }

  probeRecord(record: AgentSessionRecord): Promise<AgentSessionOwnerProbe> {
    return (
      this.deps.probeOwner?.(record) ??
      Promise.resolve({
        outcome: 'indeterminate',
        reason: 'This host cannot probe structured session owners.'
      })
    )
  }
}
