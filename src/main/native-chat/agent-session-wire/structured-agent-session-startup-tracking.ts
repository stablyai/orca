import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'
import {
  STRUCTURED_AGENT_SESSION_STARTUP_EXIT_GRACE_MS,
  StructuredAgentSessionStartupContractError,
  type StructuredAgentSessionStartupAttempt
} from './structured-agent-session-startup-attempt-contract'
import { AgentSessionStartFailure } from './structured-agent-session-start-failure'

export type StructuredAgentSessionExpiredStartup = {
  sessionId: string
  attemptId: string
  child: StructuredAgentSessionProviderChildIdentity | null
}

export type StructuredAgentSessionStartupSettled = {
  agent: AgentSessionJournalIdentity['agent']
  outcome: 'ready' | 'ceiling' | 'ended'
  durationMs: number
}

export type StructuredAgentSessionStartupProgress = {
  spawned: () => void
}

export type StructuredAgentSessionTrackedStartup = {
  attemptId: string
  attempt: StructuredAgentSessionStartupAttempt | null
  child: StructuredAgentSessionProviderChildIdentity | null
  /** Absolute ceiling starts before any startup wait. */
  registeredAt: number
  spawnedAt: number | null
  timer: ReturnType<typeof setTimeout> | null
  expired: boolean
  /** Defer expiry reporting until aborted spawn settles; successful readiness overrides it. */
  expiry: StructuredAgentSessionStartupSettled | null
  readiness: PromiseWithResolvers<'ready' | 'ended'>
  /** When the adapter first saw this acquisition's own root exit; it shortens the deadline. */
  rootExitAt: number | null
  rootExit: PromiseWithResolvers<void>
  stopListening?: () => void
  /** Set before readiness settles when the start's owner or the contract guard failed it. */
  failure?: AgentSessionStartFailure
}

export function trackedStartup(
  attemptId: string,
  registeredAt: number
): StructuredAgentSessionTrackedStartup {
  return {
    attemptId,
    attempt: null,
    child: null,
    registeredAt,
    spawnedAt: null,
    timer: null,
    expired: false,
    expiry: null,
    readiness: Promise.withResolvers(),
    rootExitAt: null,
    rootExit: Promise.withResolvers()
  }
}

/** The earlier of the original deadline and the grace after the acquisition's own root exit. */
export function startupDue(
  tracked: StructuredAgentSessionTrackedStartup,
  ceilingMs: number
): number {
  return Math.min(
    tracked.registeredAt + ceilingMs,
    (tracked.rootExitAt ?? Infinity) + STRUCTURED_AGENT_SESSION_STARTUP_EXIT_GRACE_MS
  )
}

/** A broken adapter contract fails its start for good, worded as the agent failing to start. */
export function startupContractFailure(agent: string): AgentSessionStartFailure {
  return new AgentSessionStartFailure(
    new StructuredAgentSessionStartupContractError(agent),
    'never',
    agentSessionFailureFact('providerStartFailed')
  )
}

export function measureStartup(
  tracked: StructuredAgentSessionTrackedStartup,
  outcome: StructuredAgentSessionStartupSettled['outcome'],
  now: number
): StructuredAgentSessionStartupSettled | null {
  return tracked.spawnedAt === null || !tracked.attempt
    ? null
    : {
        agent: tracked.attempt.identity.agent,
        outcome,
        durationMs: Math.max(0, now - tracked.spawnedAt)
      }
}
