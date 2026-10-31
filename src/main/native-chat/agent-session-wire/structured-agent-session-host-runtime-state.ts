import { createRestartReconciler } from './structured-agent-session-restart-reconcile'
import { StructuredAgentSessionDeliveryOrder } from './structured-agent-session-delivery-order'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  createDeferredStructuredAgentSessionEventSink,
  type DeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionSinkBarrier
} from './structured-agent-session-event-sink'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host'
import { StructuredAgentSessionAcquireAborts } from './structured-agent-session-acquire-aborts'
import { StructuredAgentSessionStartFlights } from './structured-agent-session-start-flight'
import { StructuredAgentSessionLeaseRenewer } from './structured-agent-session-lease-renewer'
import {
  heldProviderChildReader,
  type ProviderChildSessions
} from './structured-agent-session-provider-child'
import { resolveStructuredSessionRecovery } from './structured-agent-session-recovery-resolution'
import { recordAgentSessionStartup } from '../../observability/agent-session-instrumentation'
import {
  StructuredAgentSessionStartupAttempts,
  type StructuredAgentSessionExpiredStartup
} from './structured-agent-session-startup-attempt'
import { StructuredAgentSessionStartupExpiredError } from './structured-agent-session-startup-attempt-contract'

export class StructuredAgentSessionHostRuntimeState {
  private readonly eventSinks = new Map<string, DeferredStructuredAgentSessionEventSink>()
  readonly deliveryOrder = new StructuredAgentSessionDeliveryOrder()
  readonly acquireAborts = new StructuredAgentSessionAcquireAborts()
  readonly startFlights = new StructuredAgentSessionStartFlights()
  readonly reconcileLeases: ReturnType<typeof createRestartReconciler>
  readonly startupAttempts: StructuredAgentSessionStartupAttempts
  private readonly leaseRenewer: StructuredAgentSessionLeaseRenewer
  private readonly onEventSinkFailure?: (sessionId: string, error: unknown) => void

  constructor(
    private readonly deps: StructuredAgentSessionHostDeps,
    /** Held children renew without PID probes. */
    sessions: ProviderChildSessions,
    onEventSinkFailure?: (sessionId: string, error: unknown) => void,
    /** Expire published starts; still-acquiring attempts abort here. */
    onStartupExpired?: (expired: StructuredAgentSessionExpiredStartup) => void
  ) {
    this.onEventSinkFailure = onEventSinkFailure
    this.startupAttempts = new StructuredAgentSessionStartupAttempts({
      ...(deps.startupLimits ? { limits: deps.startupLimits } : {}),
      settled: recordAgentSessionStartup,
      expire: (expired) => {
        this.acquireAborts.abort(expired.sessionId, new StructuredAgentSessionStartupExpiredError())
        if (expired.child !== null) {
          onStartupExpired?.(expired)
        }
      }
    })
    this.leaseRenewer = new StructuredAgentSessionLeaseRenewer({
      store: deps.store,
      probe: (record) => this.probeRecord(record),
      ...(deps.probeOwners ? { probeMany: deps.probeOwners } : {}),
      holdsLiveChild: heldProviderChildReader(sessions, deps.adapter),
      now: () => deps.now?.() ?? Date.now(),
      // Ownership errors remain transient/visible; only sink I/O failure may force provider shutdown.
      logger: deps.logger
    })
    this.reconcileLeases = createRestartReconciler({
      store: deps.store,
      probe: (record) => this.probeRecord(record),
      ...(deps.probeOwners ? { probeMany: deps.probeOwners } : {}),
      now: () => this.deps.now?.() ?? Date.now()
    })
  }

  startLeaseRenewal(): void {
    this.leaseRenewer.start()
  }

  stopLeaseRenewal(): Promise<void> {
    return this.leaseRenewer.stop()
  }

  eventSinkFor(sessionId: string): DeferredStructuredAgentSessionEventSink {
    const existing = this.currentEventSink(sessionId)
    if (existing) {
      return existing
    }
    const created = this.mintEventSink(sessionId)
    this.eventSinks.set(sessionId, created)
    return created
  }

  /** Failed sinks retain permanent barrier errors; discard instead of reusing them. */
  currentEventSink(sessionId: string): DeferredStructuredAgentSessionEventSink | undefined {
    const existing = this.eventSinks.get(sessionId)
    if (existing?.state().failed) {
      existing.close()
      this.eventSinks.delete(sessionId)
      return undefined
    }
    return existing
  }

  /** Cache only after adoption so failed attempts cannot leave queues for later attaches. */
  mintEventSink(sessionId: string): DeferredStructuredAgentSessionEventSink {
    const minted: DeferredStructuredAgentSessionEventSink =
      createDeferredStructuredAgentSessionEventSink({
        sessionId,
        logger: this.deps.logger,
        onFailed: (error) => {
          // Attempt sinks cannot force down the session’s adopted provider.
          if (this.eventSinks.get(sessionId) === minted) {
            this.onEventSinkFailure?.(sessionId, error)
          }
        }
      })
    return minted
  }

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
      this.currentEventSink(sessionId)?.drained() ?? Promise.resolve({ ok: true } as const)
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
      return Promise.resolve({ outcome: 'reservation-unused' })
    }
    // Live reservations require strict processless proof before another writer can spawn.
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
