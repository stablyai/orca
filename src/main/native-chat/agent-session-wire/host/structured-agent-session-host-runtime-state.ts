import {
  sameProviderChild,
  heldProviderChildReader
} from './structured-agent-session-provider-child'
import { sameJournalCursor } from '../../agent-session-journal/replay/journal-cursor'
import { readHostStructuredAgentSessionWork } from '../observations/structured-agent-session-read-work'
import { createRestartReconciler } from '../recovery/structured-agent-session-restart-reconcile'
import { StructuredAgentSessionDeliveryOrder } from '../delivery/structured-agent-session-delivery-order'
import type { AgentSessionOwnerProbe } from '../../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  createDeferredStructuredAgentSessionEventSink,
  type DeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionSinkBarrier
} from '../journal-ingress/structured-agent-session-event-sink'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionHostDeps
} from './structured-agent-session-host-types'
import { StructuredAgentSessionAcquireAborts } from '../startup/structured-agent-session-acquire-aborts'
import { StructuredAgentSessionStartFlights } from '../startup/structured-agent-session-start-flight'
import { StructuredAgentSessionLeaseRenewer } from './structured-agent-session-lease-renewer'
import { resolveStructuredSessionRecovery } from '../recovery/structured-agent-session-recovery-resolution'
import { recordAgentSessionStartup } from '../../../observability/agent-session-instrumentation'
import { StructuredAgentSessionStartupAttempts } from '../startup/structured-agent-session-startup-attempt'

import type { StructuredAgentSessionExpiredStartup } from '../startup/structured-agent-session-startup-tracking'
import type { StructuredAgentSessionClientDelivery } from '../publication/subscribers/structured-agent-session-client-delivery'
import {
  StructuredAgentSessionStartupContractError,
  StructuredAgentSessionStartupExpiredError
} from '../startup/structured-agent-session-startup-attempt-contract'

export class StructuredAgentSessionHostRuntimeState {
  private readonly eventSinks = new Map<string, DeferredStructuredAgentSessionEventSink>()
  readonly deliveryOrder = new StructuredAgentSessionDeliveryOrder()
  readonly acquireAborts: StructuredAgentSessionAcquireAborts
  readonly startFlights: StructuredAgentSessionStartFlights
  readonly reconcileLeases: ReturnType<typeof createRestartReconciler>
  readonly startupAttempts: StructuredAgentSessionStartupAttempts
  private readonly leaseRenewer: StructuredAgentSessionLeaseRenewer
  private readonly onEventSinkFailure?: (sessionId: string, error: unknown) => void

  constructor(
    private readonly deps: StructuredAgentSessionHostDeps,
    /** Held children renew without PID probes. */
    private readonly sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>,
    onEventSinkFailure?: (sessionId: string, error: unknown) => void,
    /** Expire published starts; still-acquiring attempts abort here. */
    onStartupExpired?: (expired: StructuredAgentSessionExpiredStartup) => void,
    private readonly deliveryActive?: (sessionId: string) => boolean,
    private readonly childWork?: Pick<
      StructuredAgentSessionClientDelivery,
      'childWorkOpen' | 'drainChildWork'
    >
  ) {
    this.acquireAborts = new StructuredAgentSessionAcquireAborts((id) => this.refreshActivity(id))
    this.startFlights = new StructuredAgentSessionStartFlights((id) => this.refreshActivity(id))
    this.onEventSinkFailure = onEventSinkFailure
    this.startupAttempts = new StructuredAgentSessionStartupAttempts({
      ...(deps.startupLimits ? { limits: deps.startupLimits } : {}),
      settled: recordAgentSessionStartup,
      expire: (expired) => {
        this.acquireAborts.abort(expired.sessionId, new StructuredAgentSessionStartupExpiredError())
        if (expired.child !== null) {
          onStartupExpired?.(expired)
        }
      },
      // The exited child still ends through its own exit; only the start's waits are cancelled.
      breach: ({ sessionId, attemptId, agent }) => {
        deps.logger.warn('an agent adapter gave no startup outcome after its process exited', {
          scope: 'startup-contract',
          sessionId,
          attemptId,
          agent
        })
        this.acquireAborts.abort(sessionId, new StructuredAgentSessionStartupContractError(agent))
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

  hasDeliveryWork(sessionId: string): boolean {
    return this.startFlights.has(sessionId) || this.deliveryActive?.(sessionId) === true
  }

  private executing(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    const child = session?.child
    return (
      this.hasDeliveryWork(sessionId) ||
      this.acquireAborts.has(sessionId) ||
      this.hasPendingIngress(sessionId) ||
      (!!child &&
        (child.phase === 'starting' ||
          !!child.close ||
          (!!session?.lastEndedChild && sameProviderChild(session.lastEndedChild, child))))
    )
  }

  /** Current owners cover ingress synchronously; the named reader covers gaps between turn writes. */
  refreshActivity(sessionId: string): void {
    const database = this.deps.journalDatabase
    if (this.executing(sessionId)) {
      database.setSessionActive(sessionId, true)
      return
    }
    const session = this.sessions.get(sessionId)
    const child = session?.child
    if (!session || !child || database.isClosed) {
      database.setSessionActive(sessionId, false)
      return
    }
    if (session.activityRead) {
      return
    }
    const release = database.holdActivity()
    database.setSessionActive(sessionId, false)
    session.activityRead = Promise.resolve()
      .then(() => this.readActivity(sessionId, session))
      .finally(release)
  }

  private async readActivity(
    sessionId: string,
    session: StructuredAgentSessionHostSession
  ): Promise<void> {
    const database = this.deps.journalDatabase
    try {
      while (this.sessions.get(sessionId) === session) {
        const child = session.child
        if (this.executing(sessionId) || !child || database.isClosed) {
          database.setSessionActive(sessionId, this.executing(sessionId))
          return
        }
        const cursor = session.journal.cursor()
        const physical = session.journal.physicalCursor()
        const revision = session.operationalRevision
        const current = () =>
          this.sessions.get(sessionId) === session &&
          session.child === child &&
          sameJournalCursor(cursor, session.journal.cursor()) &&
          sameJournalCursor(physical, session.journal.physicalCursor()) &&
          revision === session.operationalRevision
        try {
          const work = await readHostStructuredAgentSessionWork(
            { store: this.deps.store, sessions: this.sessions },
            sessionId,
            { kind: 'child-work' }
          )
          if (!current()) {
            continue
          }
          database.setSessionActive(
            sessionId,
            this.executing(sessionId) ||
              work.activeTurn ||
              work.actionablePrompt ||
              this.childWork?.childWorkOpen(sessionId) === true
          )
        } catch (error) {
          if (!current()) {
            continue
          }
          database.setSessionActive(sessionId, this.executing(sessionId))
          if (!database.isClosed && !session.journal.isClosed) {
            this.deps.logger.warn('reading live chat activity failed', {
              scope: 'journal-database-activity',
              sessionId,
              error
            })
          }
        }
        return
      }
      this.refreshActivity(sessionId)
    } finally {
      session.activityRead = undefined
    }
  }

  startLeaseRenewal(): void {
    this.leaseRenewer.start()
  }

  hasPendingIngress(sessionId: string): boolean {
    return (this.eventSinks.get(sessionId)?.state().queuedWorkOperations ?? 0) > 0
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

  sealEventSink = (sessionId: string): void => this.eventSinks.get(sessionId)?.seal()

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
        onWorkChanged: () => this.refreshActivity(sessionId),
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
    this.refreshActivity(sessionId)
  }

  discardEventSink(sessionId: string): void {
    this.eventSinks.delete(sessionId)
    this.refreshActivity(sessionId)
  }

  async flushEventSink(sessionId: string): Promise<void> {
    await this.requireSuccessfulBarrier(
      this.currentEventSink(sessionId)?.drained() ?? Promise.resolve({ ok: true } as const)
    )
    await this.childWork?.drainChildWork(sessionId)
    await this.requireSuccessfulBarrier(
      this.currentEventSink(sessionId)?.drained() ?? Promise.resolve({ ok: true } as const)
    )
  }

  async lifecycleBarrier(sessionId: string): Promise<StructuredAgentSessionSinkBarrier> {
    const barrier = await (this.eventSinks.get(sessionId)?.lifecycleBarrier() ??
      Promise.resolve({ ok: true } as const))
    if (!barrier.ok) {
      return barrier
    }
    await this.childWork?.drainChildWork(sessionId)
    return this.eventSinks.get(sessionId)?.lifecycleBarrier() ?? { ok: true }
  }

  async flushAllEventSinks(): Promise<void> {
    await Promise.all(
      [...this.eventSinks.values()].map((sink) => this.requireSuccessfulBarrier(sink.drained()))
    )
    await this.childWork?.drainChildWork()
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
