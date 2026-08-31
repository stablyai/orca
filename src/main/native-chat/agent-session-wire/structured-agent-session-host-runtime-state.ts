import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  createDeferredStructuredAgentSessionEventSink,
  type DeferredStructuredAgentSessionEventSink
} from './structured-agent-session-event-sink'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host'
import { StructuredAgentSessionLeaseRenewer } from './structured-agent-session-lease-renewer'
import { resolveStructuredSessionRecovery } from './structured-agent-session-recovery-resolution'

export class StructuredAgentSessionHostRuntimeState {
  private readonly eventSinks = new Map<string, DeferredStructuredAgentSessionEventSink>()
  private readonly leaseRenewer: StructuredAgentSessionLeaseRenewer

  constructor(
    private readonly deps: StructuredAgentSessionHostDeps,
    onLeaseRenewed?: (record: AgentSessionRecord) => Promise<void>,
    onDeadTuiOwner?: (record: AgentSessionRecord, probe: AgentSessionOwnerProbe) => Promise<void>
  ) {
    this.leaseRenewer = new StructuredAgentSessionLeaseRenewer({
      store: deps.store,
      probe: (record) => this.probeRecord(record),
      ...(deps.probeOwners ? { probeMany: deps.probeOwners } : {}),
      now: () => deps.now?.() ?? Date.now(),
      ...(onLeaseRenewed ? { onRenewed: onLeaseRenewed } : {}),
      ...(onDeadTuiOwner ? { onDeadTuiOwner } : {}),
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
      return existing
    }
    const created = createDeferredStructuredAgentSessionEventSink({
      onError: (error) => this.deps.onEventSinkError?.({ sessionId, error })
    })
    this.eventSinks.set(sessionId, created)
    return created
  }

  discardEventSink(sessionId: string): void {
    this.eventSinks.delete(sessionId)
  }

  flushEventSink(sessionId: string): Promise<void> {
    return this.eventSinks.get(sessionId)?.drained() ?? Promise.resolve()
  }

  async flushAllEventSinks(): Promise<void> {
    await Promise.all([...this.eventSinks.values()].map((sink) => sink.drained()))
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
