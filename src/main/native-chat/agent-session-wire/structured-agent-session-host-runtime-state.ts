import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  createDeferredStructuredAgentSessionEventSink,
  type DeferredStructuredAgentSessionEventSink
} from './structured-agent-session-event-sink'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host'
import { StructuredAgentSessionLeaseRenewer } from './structured-agent-session-lease-renewer'

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

  probeOwner(sessionId: string): Promise<AgentSessionOwnerProbe> {
    const record = this.deps.store.getRecord(sessionId)
    if (!record || record.lease.ownerProcess === null) {
      return Promise.resolve({ outcome: 'reservation-unused' })
    }
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
