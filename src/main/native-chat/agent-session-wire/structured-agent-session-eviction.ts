// After proven exit, release sink/adapter routes while retaining the conversation journal.
// Attempt every cleanup step despite failures; bookkeeping cannot gate later sends.

import type { DeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

export type StructuredAgentSessionEvictionContext = {
  sessionId: string
  eventSink: Pick<DeferredStructuredAgentSessionEventSink, 'drained' | 'unbind' | 'close'>
  logger: StructuredAgentSessionLogger
  /** Drop adapter routing after lease release, retaining the conversation journal. */
  acknowledgeRelease: () => Promise<void> | void
  discardSink: () => void
}

/** Advisory resume snapshots must not block child shutdown. */
export const SNAPSHOT_DRAIN_TIMEOUT_MS = 1_000

export type StructuredAgentSessionEvictionStep = {
  name: string
  run: (context: StructuredAgentSessionEvictionContext) => Promise<void> | void
}

/** Capture already-delivered output before shutdown; snapshot failures are log-only. */
export async function snapshotBeforeStructuredAgentSessionStop(
  context: Pick<StructuredAgentSessionEvictionContext, 'sessionId' | 'eventSink' | 'logger'>,
  snapshot: () => void
): Promise<void> {
  await withTimeout<unknown>(context.eventSink.drained(), SNAPSHOT_DRAIN_TIMEOUT_MS, null)
  try {
    snapshot()
  } catch {
    context.logger.warn('capturing a recovery witness before a stop failed', {
      scope: 'recovery-witness',
      sessionId: context.sessionId
    })
  }
}

export const STRUCTURED_AGENT_SESSION_EVICTION_STEPS: readonly StructuredAgentSessionEvictionStep[] =
  [
    { name: 'stop-publishing', run: (context) => context.eventSink.unbind() },
    { name: 'close-sink', run: (context) => context.eventSink.close() },
    // Discard closed cached sinks or reopened chats would inherit a permanently closed writer.
    { name: 'discard-sink', run: (context) => context.discardSink() },
    { name: 'acknowledge-release', run: (context) => context.acknowledgeRelease() }
  ]

export class StructuredAgentSessionEvictionError extends Error {
  constructor(
    readonly step: string,
    readonly sessionId: string,
    override readonly cause: unknown
  ) {
    super(`agent session eviction failed at step "${step}" for ${sessionId}`)
    this.name = 'StructuredAgentSessionEvictionError'
  }
}

/** Report each failed step and continue cleanup. */
export async function evictStructuredAgentSession(
  context: StructuredAgentSessionEvictionContext,
  steps: readonly StructuredAgentSessionEvictionStep[] = STRUCTURED_AGENT_SESSION_EVICTION_STEPS
): Promise<void> {
  for (const step of steps) {
    try {
      await step.run(context)
    } catch (error) {
      context.logger.warn('a wind-down step after the agent exited failed', {
        scope: 'exit-wind-down',
        sessionId: context.sessionId,
        error: new StructuredAgentSessionEvictionError(step.name, context.sessionId, error)
      })
    }
  }
}
