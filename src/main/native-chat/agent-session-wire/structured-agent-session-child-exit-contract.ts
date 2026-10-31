import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionLeaseStore } from './structured-agent-session-lease-release'
import type { StructuredAgentSessionLeftoverStore } from './structured-agent-session-leftover-settlement'
import type { StructuredAgentSessionSinkBarrier } from './structured-agent-session-event-sink'
import type { StaleStructuredAgentSessionStateJournal } from './structured-agent-session-stale-state-settlement'
import type { DeadGenerationJournal } from './structured-agent-session-unfinished-work'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionStartFlights } from './structured-agent-session-start-flight'
import type { StructuredAgentSessionStartupAttempts } from './structured-agent-session-startup-attempt'
import type { SubmissionRejectionFact } from '../../../shared/agent-session-failure'
import type { StructuredAgentSessionEndedEvent } from './structured-agent-session-adapter'

export type StructuredAgentSessionChildExit = {
  deathEvidenceKind?: 'kill-delivered'
  heldSends?: ReadonlySet<string>
  expected: boolean
  /** Log only; failure supplies user-facing wording. */
  reason: string
  failure?: SubmissionRejectionFact
  observedAt?: number
  startupUnanswered?: true
  startupFailure?: StructuredAgentSessionEndedEvent['startupFailure']
}

export function structuredAgentSessionEndedEventExit(
  event: StructuredAgentSessionEndedEvent
): StructuredAgentSessionChildExit {
  return {
    expected: event.cause === 'requested-close',
    ...(event.deathEvidenceKind ? { deathEvidenceKind: event.deathEvidenceKind } : {}),
    reason: event.reason,
    ...(event.startupFailure ? { startupFailure: event.startupFailure } : {}),
    ...(event.failure ? { failure: event.failure } : {}),
    ...(event.observedAt === undefined ? {} : { observedAt: event.observedAt }),
    ...(event.startupUnanswered ? { startupUnanswered: event.startupUnanswered } : {})
  }
}

export type StructuredAgentSessionChildExitSession = Pick<
  StructuredAgentSessionHostSession,
  'child' | 'lastEndedChild'
> & { journal: DeadGenerationJournal & StaleStructuredAgentSessionStateJournal }

export type StructuredAgentSessionGenerationEnded = (
  sessionId: string,
  options?: { restate?: boolean }
) => void

export type StructuredAgentSessionChildExitContext<
  TSession extends StructuredAgentSessionChildExitSession = StructuredAgentSessionHostSession
> = {
  store: StructuredAgentSessionLeaseStore & StructuredAgentSessionLeftoverStore
  sessions: Map<string, TSession>
  flushLifecycle: (sessionId: string) => Promise<StructuredAgentSessionSinkBarrier>
  publishStatus?: (sessionId: string) => void
  /** Re-derive current work and wake queue without requiring a row; restate rebaselines moved fences. */
  generationEnded: StructuredAgentSessionGenerationEnded
  wakeDelivery?: (sessionId: string) => void
  startupAttempts?: Pick<StructuredAgentSessionStartupAttempts, 'childEnded' | 'childFailed'>
  /** Retain exits between background-start spawn and publication. */
  startFlights?: Pick<StructuredAgentSessionStartFlights, 'deferExit' | 'ownsChild'>
  abortBound?: (sessionId: string) => void
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
  logger: StructuredAgentSessionLogger
  /** Failed-start handed-over sends settle like queued work because none ran. */
  holdUnrunSends?: (
    sessionId: string,
    fence: number,
    cause: 'chatClosed' | 'hostRestarted'
  ) => Promise<void>
  /** Release sink/route now; absent defers cleanup to next attach. */
  route?: {
    runtimeState: Pick<StructuredAgentSessionHostRuntimeState, 'eventSinkFor' | 'discardEventSink'>
    acknowledgeRelease: (sessionId: string) => Promise<void> | void
  }
}
