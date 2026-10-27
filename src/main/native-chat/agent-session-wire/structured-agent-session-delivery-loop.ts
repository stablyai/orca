import type { StructuredAgentSessionDeliveryLoopDeps } from './structured-agent-session-delivery-loop-deps'
// Accept sends separately, then derive each delivery step from journal/child state. Wait outside
// serialization for startup/readiness/provider calls so acceptance and Stop stay responsive.
// Recover earlier-process queued sends before any handover; running commands block input.

import { beginStructuredAgentSessionInputHandover } from './structured-agent-session-input-handover'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { structuredAgentSessionStartFailure } from './structured-agent-session-failure-text'
import type { StructuredAgentSessionStartClaim } from './structured-agent-session-agent-start'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'
import {
  oldestQueuedSubmission,
  recordStructuredAgentSessionStartFailure,
  startThatFailedWhileQueued
} from './structured-agent-session-start-failure-row'
import type { StructuredAgentSessionPendingHandover } from './structured-agent-session-handover'
import { structuredAgentSessionNextHandover } from './structured-agent-session-opening-send'
import { structuredAgentSessionCommandRunning } from './structured-agent-session-command-turn'
import type { StructuredAgentSessionStartReadiness } from './structured-agent-session-startup-attempt'
import { holdRestartedStructuredAgentSessionSends } from './structured-agent-session-host-lifetime'
import { structuredAgentSessionEndedChildFailure } from './structured-agent-session-ended-child-failure'
import { waitsForCodexTurnOptions } from './structured-agent-session-message-options'
import { sameProviderChild } from './structured-agent-session-provider-child'

export type { StructuredAgentSessionDeliveryLoopDeps } from './structured-agent-session-delivery-loop-deps'

type Prepared =
  | 'stop'
  | 'continue'
  | { start: StructuredAgentSessionStartClaim }
  | {
      ok: true
      awaited: StructuredAgentSessionProviderChildIdentity
      clientMessageId: string
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
        if (prepared === 'continue') {
          continue
        }
        if ('start' in prepared) {
          // Outside the serialize: sends are accepted while the agent starts.
          const completed = await prepared.start.outcome.then(
            () => true,
            (error: unknown) => {
              this.deps.logger.warn('waiting for an agent start failed', {
                scope: 'delivery-loop-start',
                sessionId,
                error
              })
              return false
            }
          )
          if (!completed) {
            await this.deps
              .serialize(sessionId, async () => this.stop(sessionId))
              .catch((error: unknown) =>
                this.deps.logger.warn('parking delivery after a failed start failed', {
                  scope: 'delivery-loop-start',
                  sessionId,
                  error
                })
              )
            return
          }
          // The flight settled its requester; joiners rederive their own work.
          continue
        }
        if (prepared.readiness) {
          await prepared.readiness.wait()
        }
        await prepared.before
        const handed = await this.deps.serialize(sessionId, () =>
          this.handOver(
            sessionId,
            prepared.awaited,
            prepared.clientMessageId,
            prepared.readiness !== null
          )
        )
        if (handed === 'stop') {
          return
        }
        if (handed !== 'continue') {
          // Track the external provider call and settlement so quit waits after abort.
          await this.deps.trackStart(
            handed.run((resolve) => this.deps.serialize(sessionId, resolve))
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
        .serialize(sessionId, async () => {
          try {
            const session = this.deps.sessions.get(sessionId)
            const selected = session && oldestQueuedSubmission(session)
            await this.fail(sessionId, { startKey: null, cause }, selected?.clientMessageId ?? null)
          } finally {
            this.stop(sessionId)
          }
        })
        .catch((failure: unknown) => {
          // Keep failed-settlement leftovers for the next accept/open recovery.
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
    if (this.deps.startFlights?.has(sessionId)) {
      return { start: this.deps.startProviderChild(sessionId, oldest.clientMessageId) }
    }
    const failedStart = startThatFailedWhileQueued(session, oldest)
    if (failedStart) {
      return this.fail(sessionId, failedStart, oldest.clientMessageId)
    }
    await this.deps.retireOutgrownChild(sessionId)
    const child = this.deps.sessions.get(sessionId)?.child
    if (!child || child.close) {
      return {
        start: this.deps.startProviderChild(sessionId, oldest.clientMessageId)
      }
    }
    return {
      ok: true,
      awaited: { generation: child.generation, fence: child.fence },
      clientMessageId: oldest.clientMessageId,
      readiness: child.phase === 'starting' ? this.deps.readiness(sessionId, child) : null,
      before: this.deps.deliveryOrder.beforeSend(sessionId, oldest.clientMessageId)
    }
  }

  private async handOver(
    sessionId: string,
    awaited: StructuredAgentSessionProviderChildIdentity,
    clientMessageId: string,
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
      return this.fail(
        sessionId,
        {
          startKey: awaited.generation,
          cause: endedFailure ??
            // Gone with no end observed: nothing says the provider stopped.
            { failure: agentSessionFailureFact('startFailed') }
        },
        clientMessageId
      )
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
    const pending = await beginStructuredAgentSessionInputHandover(
      this.deps,
      sessionId,
      session,
      awaitedChild,
      next,
      () => this.disposed
    )
    return pending ?? 'continue'
  }

  private async fail(
    sessionId: string,
    failure: StartFailure,
    clientMessageId: string | null
  ): Promise<'continue'> {
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
        clientMessageId
      )
    }
    return 'continue'
  }

  /** Clear under serialization so the next accept can wake a new loop. */
  private stop(sessionId: string): 'stop' {
    this.running.delete(sessionId)
    this.deps.deliveryOrder.parkSends(sessionId)
    return 'stop'
  }
}
