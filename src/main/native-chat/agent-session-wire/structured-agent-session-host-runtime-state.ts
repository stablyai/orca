import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  createDeferredStructuredAgentSessionEventSink,
  type DeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionSinkBarrier
} from './structured-agent-session-event-sink'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host'
import { StructuredAgentSessionLeaseRenewer } from './structured-agent-session-lease-renewer'
import { resolveStructuredSessionRecovery } from './structured-agent-session-recovery-resolution'

export class StructuredAgentSessionHostRuntimeState {
  private readonly eventSinks = new Map<string, DeferredStructuredAgentSessionEventSink>()
  private readonly leaseRenewer: StructuredAgentSessionLeaseRenewer
  private readonly onEventSinkFailure?: (sessionId: string, error: unknown) => void

  constructor(
    private readonly deps: StructuredAgentSessionHostDeps,
    onLeaseRenewed?: (record: AgentSessionRecord) => Promise<void>,
    onDeadTuiOwner?: (record: AgentSessionRecord, probe: AgentSessionOwnerProbe) => Promise<void>,
    onEventSinkFailure?: (sessionId: string, error: unknown) => void
  ) {
    this.onEventSinkFailure = onEventSinkFailure
    this.leaseRenewer = new StructuredAgentSessionLeaseRenewer({
      store: deps.store,
      probe: (record) => this.probeRecord(record),
      ...(deps.probeOwners ? { probeMany: deps.probeOwners } : {}),
      now: () => deps.now?.() ?? Date.now(),
      ...(onLeaseRenewed ? { onRenewed: onLeaseRenewed } : {}),
      ...(onDeadTuiOwner ? { onDeadTuiOwner } : {}),
      // Lease/ownership failures are transient and stay on the visible lease-error path.
      // Only deferred sink I/O failures are terminal and may force-close a provider.
      onError: ({ sessionId, error }) => deps.onEventSinkError?.({ sessionId, error })
    })
  }

  startLeaseRenewal(): void {
    this.leaseRenewer.start()
  }

  stopLeaseRenewal(): void {
    this.leaseRenewer.stop()
  }

  eventSinkFor(sessionId: string): DeferredStructuredAgentSessionEventSink {
    const existing = this.eventSinks.get(sessionId)
    if (existing) {
      // A sink failure is terminal for that sink instance. Reusing it on a
      // recovery attach makes `drained()` return the old error forever and
      // prevents the newly acquired journal from accepting provider events.
      // Replace the cache entry before attach calls its drain barrier.
      if (existing.state().failed) {
        existing.close()
        this.eventSinks.delete(sessionId)
      } else {
        return existing
      }
    }
    const created = createDeferredStructuredAgentSessionEventSink({
      onError: (error) => {
        this.deps.onEventSinkError?.({ sessionId, error })
        this.onEventSinkFailure?.(sessionId, error)
      }
    })
    this.eventSinks.set(sessionId, created)
    return created
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

  /** Exit from a latched recovery stage when present-time evidence permits one. */
  resolveRecovery(sessionId: string): Promise<'resolved' | 'unresolved' | 'not-applicable'> {
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
