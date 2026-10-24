// Accept sends separately, then derive each delivery step from journal/child state. Wait outside
// serialization for startup/readiness/provider calls so acceptance and Stop stay responsive.
// Recover earlier-process queued sends before any handover; running commands block input.

import type { StructuredAgentSessionDeliveryOrder } from './structured-agent-session-delivery-order'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { AgentSessionFailureWordsContext } from '../../../shared/agent-session-failure-words'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentRegistry } from './structured-agent-registry'
import { structuredAgentSessionStartFailure } from './structured-agent-session-failure-text'
import type { StructuredAgentSessionStartClaim } from './structured-agent-session-agent-start'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'
import {
  acceptedNoLaterThan,
  oldestQueuedSubmission,
  recordStructuredAgentSessionStartFailure,
  refusedStructuredAgentSessionStart,
  startThatFailedWhileQueued
} from './structured-agent-session-start-failure-row'
import {
  beginSubmissionHandover,
  type StructuredAgentSessionPendingHandover
} from './structured-agent-session-handover'
import { structuredAgentSessionNextHandover } from './structured-agent-session-opening-send'
import { structuredAgentSessionCommandRunning } from './structured-agent-session-command-turn'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { StructuredAgentSessionStartReadiness } from './structured-agent-session-startup-attempt'
import { holdRestartedStructuredAgentSessionSends } from './structured-agent-session-host-lifetime'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { structuredAgentSessionEndedChildFailure } from './structured-agent-session-ended-child-failure'
import { waitsForCodexTurnOptions } from './structured-agent-session-message-options'
import type { StructuredAgentSessionRanRecorder } from './structured-agent-session-ran-options'
import { sameProviderChild } from './structured-agent-session-provider-child'
import type { StructuredAgentSessionAcquireAborts } from './structured-agent-session-acquire-aborts'

export type StructuredAgentSessionDeliveryLoopDeps = {
  deliveryOrder: StructuredAgentSessionDeliveryOrder
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  adapter: StructuredAgentSessionAdapter
  agents: StructuredAgentRegistry
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** Track from enqueue so quit drains any child the start may create. */
  trackStart: <T>(start: Promise<T>) => Promise<T>
  startProviderChild: (sessionId: string, startedFor: string) => StructuredAgentSessionStartClaim
  /** Retire mismatched login/permission children under serialization. */
  retireOutgrownChild: (sessionId: string) => Promise<void>
  readiness: (
    sessionId: string,
    child: StructuredAgentSessionProviderChildIdentity
  ) => StructuredAgentSessionStartReadiness | null
  conversationFence: (sessionId: string) => number
  /** Settle sends covered by partial close; later sends remain eligible. False means settlement failed. */
  closeWhatTheUserClosed: (sessionId: string) => Promise<boolean>
  failureTextContext: (sessionId: string) => AgentSessionFailureWordsContext
  logger: StructuredAgentSessionLogger
  record: (sessionId: string) => AgentSessionRecord | null
  currentWork: (sessionId: string) => StructuredAgentSessionCurrentWork | null
  /** Publish row-free changes in current work. */
  workChanged?: (sessionId: string) => void
  readChildWork: (sessionId: string) => readonly AgentChildWorkView[] | undefined
  childWorkOpen: (sessionId: string) => boolean
  stopping: (sessionId: string) => boolean
  now: () => number
  acquireAborts: Pick<StructuredAgentSessionAcquireAborts, 'begin'>
  recordRanOptions?: StructuredAgentSessionRanRecorder
}

type Prepared =
  | 'stop'
  | { start: StructuredAgentSessionStartClaim; acceptedBy: AgentJournalCursor }
  | {
      ok: true
      awaited: StructuredAgentSessionProviderChildIdentity
      readiness: StructuredAgentSessionStartReadiness | null
      before: Promise<void>
    }

type StartFailure = NonNullable<ReturnType<typeof startThatFailedWhileQueued>>

export class StructuredAgentSessionDeliveryLoop {
  private readonly running = new Set<string>()
  private readonly runs = new Map<string, Promise<void>>()
  private disposed = false

  constructor(private readonly deps: StructuredAgentSessionDeliveryLoopDeps) {}

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  dispose(): void {
    this.disposed = true
    this.deps.deliveryOrder.dispose()
  }

  /** Wake under serialization; re-read existing loops next step. Resolve when delivery parks; never reject. */
  wake(sessionId: string): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }
    this.deps.deliveryOrder.reconcile(
      sessionId,
      this.deps.sessions.get(sessionId)?.journal.submissions() ?? []
    )
    if (this.running.has(sessionId)) {
      return this.runs.get(sessionId) ?? Promise.resolve()
    }
    this.running.add(sessionId)
    const run = this.run(sessionId).finally(() => {
      if (this.runs.get(sessionId) === run) {
        this.runs.delete(sessionId)
      }
    })
    this.runs.set(sessionId, run)
    return run
  }

  private async run(sessionId: string): Promise<void> {
    try {
      for (;;) {
        const prepared = await this.deps.trackStart(
          this.deps.serialize(sessionId, () => this.prepare(sessionId))
        )
        if (prepared === 'stop') {
          return
        }
        if ('start' in prepared) {
          // Start outside serialization so sends remain acceptable.
          const started = await prepared.start.outcome
          if (started.ok || started.aborted) {
            // Intentional cancellation settled its work; re-derive so later sends get fresh starts and quit stops the loop.
            continue
          }
          const failure = refusedStructuredAgentSessionStart(this.deps.record(sessionId), started)
          if (started.refusal.details?.reason !== 'previousExitUnverifiable') {
            await this.deps.serialize(sessionId, () => this.fail(sessionId, failure))
            return
          }
          // Unproven close applies only to work captured for this start; later sends may retry proof.
          await this.deps.serialize(sessionId, () =>
            this.recordFailure(sessionId, failure, prepared.acceptedBy)
          )
          continue
        }
        if (prepared.readiness) {
          await prepared.readiness.wait()
        }
        await prepared.before
        const handed = await this.deps.serialize(sessionId, () =>
          this.handOver(sessionId, prepared.awaited, prepared.readiness !== null)
        )
        if (handed === 'stop') {
          return
        }
        if (handed !== 'continue') {
          // Track the external provider call and settlement so quit waits after abort.
          await this.deps.trackStart(
            handed
              .dispatch()
              .then((resolve) => this.deps.serialize(sessionId, resolve))
              .finally(() => handed.release?.())
          )
        }
      }
    } catch (error) {
      this.deps.logger.warn('delivering a queued message failed', {
        scope: 'delivery-loop',
        sessionId,
        error
      })
      const cause = { hostFault: true } as const
      await this.deps
        .serialize(sessionId, () => this.fail(sessionId, { startKey: null, cause }))
        .catch((failure: unknown) => {
          // Keep failed-settlement leftovers for the next accept/open recovery.
          this.running.delete(sessionId)
          this.deps.logger.warn('recording a failed delivery failed', {
            scope: 'delivery-loop-fail',
            sessionId,
            error: failure
          })
        })
    }
  }

  private async prepare(sessionId: string): Promise<Prepared> {
    const session = this.deps.sessions.get(sessionId)
    if (!session || this.disposed) {
      return this.stop(sessionId)
    }
    // Retry failed open recovery before delivery; never hand over earlier-process sends.
    await holdRestartedStructuredAgentSessionSends(
      this.deps.logger,
      sessionId,
      session.journal,
      this.deps.conversationFence(sessionId)
    )
    if (!(await this.deps.closeWhatTheUserClosed(sessionId))) {
      return this.stop(sessionId)
    }
    const oldest = oldestQueuedSubmission(session)
    // Commands block while their child lives; ended command commits wake delivery again.
    const work = this.deps.currentWork(sessionId)
    if (!oldest || (session.child && work && structuredAgentSessionCommandRunning(work))) {
      return this.stop(sessionId)
    }
    const failedStart = startThatFailedWhileQueued(session, oldest)
    if (failedStart) {
      return this.fail(sessionId, failedStart)
    }
    await this.deps.retireOutgrownChild(sessionId)
    const child = this.deps.sessions.get(sessionId)?.child
    if (!child || child.close) {
      return {
        start: this.deps.startProviderChild(sessionId, oldest.clientMessageId),
        acceptedBy: session.journal.cursor()
      }
    }
    return {
      ok: true,
      awaited: { generation: child.generation, fence: child.fence },
      readiness: child.phase === 'starting' ? this.deps.readiness(sessionId, child) : null,
      before: this.deps.deliveryOrder.beforeSend(sessionId, oldest.clientMessageId)
    }
  }

  private async handOver(
    sessionId: string,
    awaited: StructuredAgentSessionProviderChildIdentity,
    waited: boolean
  ): Promise<'continue' | 'stop' | StructuredAgentSessionPendingHandover> {
    const session = this.deps.sessions.get(sessionId)
    if (!session || this.disposed) {
      return this.stop(sessionId)
    }
    // Child identity may change during external readiness waits.
    const { child } = session
    const awaitedChild = child && sameProviderChild(child, awaited) ? child : null
    if (!awaitedChild) {
      const ended = session.lastEndedChild
      const endedFailure = ended ? structuredAgentSessionEndedChildFailure(ended) : undefined
      // User Stop/close is not start failure; re-derive after closed-send settlement.
      if (endedFailure === null) {
        return 'continue'
      }
      return this.fail(sessionId, {
        startKey: awaited.generation,
        cause: endedFailure ??
          // Unknown disappearance is not an observed provider exit.
          { failure: agentSessionFailureFact('startFailed') }
      })
    }
    // Stop may take the lane during readiness; recheck before steering into work it is ending.
    if (this.deps.stopping(sessionId) || awaitedChild.phase !== 'ready') {
      return this.stop(sessionId)
    }
    // Opening turns must exist before follow-ups join them.
    const work = this.deps.currentWork(sessionId)
    const next = structuredAgentSessionNextHandover(session, awaitedChild.fence, work)
    if (!next) {
      return this.stop(sessionId)
    }
    if (waited) {
      // Verify awaited-child identity before rechecking launch permissions.
      await this.deps.retireOutgrownChild(sessionId)
      if (session.child !== awaitedChild) {
        return 'continue'
      }
    }
    if (
      waitsForCodexTurnOptions(this.deps.record(sessionId), session.journal, next, awaitedChild)
    ) {
      return this.stop(sessionId)
    }
    const pending = await beginSubmissionHandover(
      {
        sessionId,
        journal: session.journal,
        fence: awaitedChild.fence,
        adapter: this.deps.adapter,
        agents: this.deps.agents,
        failureTextContext: this.deps.failureTextContext(sessionId),
        record: () => this.deps.record(sessionId),
        currentWork: () => this.deps.currentWork(sessionId),
        childWork: () => this.deps.readChildWork(sessionId),
        childWorkOpen: () => this.deps.childWorkOpen(sessionId),
        now: this.deps.now,
        acquireAborts: this.deps.acquireAborts,
        deliveryOrder: this.deps.deliveryOrder,
        workChanged: () => this.deps.workChanged?.(sessionId),
        recordRanOptions: this.deps.recordRanOptions?.(sessionId, awaitedChild.fence)
      },
      next,
      // Recheck child identity immediately before the external provider write.
      () => this.deps.sessions.get(sessionId)?.child === awaitedChild && !awaitedChild.close
    )
    return pending ?? 'continue'
  }

  private async fail(sessionId: string, failure: StartFailure): Promise<'stop'> {
    await this.recordFailure(sessionId, failure)
    return this.stop(sessionId)
  }

  private async recordFailure(
    sessionId: string,
    failure: StartFailure,
    acceptedBy?: AgentJournalCursor
  ): Promise<void> {
    const session = this.deps.sessions.get(sessionId)
    if (session) {
      await recordStructuredAgentSessionStartFailure(
        { journal: session.journal, fence: this.deps.conversationFence(sessionId) },
        {
          startKey: failure.startKey,
          ...structuredAgentSessionStartFailure(
            failure.cause,
            this.deps.failureTextContext(sessionId)
          )
        },
        acceptedBy && acceptedNoLaterThan(session.journal, acceptedBy)
      )
    }
  }

  /** Clear under serialization so the next accept can wake a new loop. */
  private stop(sessionId: string): 'stop' {
    this.running.delete(sessionId)
    this.deps.deliveryOrder.parkSends(sessionId)
    return 'stop'
  }
}
