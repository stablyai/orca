// The host's half of a session's lifetime: what a close does, and what a hold is wired to.
//
// Lifted out of the host for the same reason attaching was — the host is a coordinator, and the
// sequence that stops a provider child and hands its lease back reads better next to the holder
// bookkeeping that decides when to run it than buried among the twenty other things a session can
// do.

import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-projection'
import {
  evictStructuredAgentSession,
  STRUCTURED_AGENT_SESSION_EVICTION_STEPS,
  type StructuredAgentSessionEvictionContext
} from './structured-agent-session-eviction'
import { withStructuredAgentSessionEvictionDeadline } from './structured-agent-session-eviction-deadline'
import { StructuredAgentSessionHolds } from './structured-agent-session-holds'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { releaseStoredStructuredAgentSessionOwner } from './structured-agent-session-lease-release'

export type StructuredAgentSessionLifetimeContext = {
  deps: StructuredAgentSessionHostDeps
  runtimeState: StructuredAgentSessionHostRuntimeState
  sessions: Map<string, StructuredAgentSessionHostSession>
  now: () => number
}

function hasProviderChild(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string
): boolean {
  return context.sessions.get(sessionId)?.hasProviderChild === true
}

/** Runs the eviction steps under a deadline. A step that fails — or runs out of time — aborts the
 *  rest, which leaves the session indexed and the child loaded so the next close is a real retry. */
export async function evictHeldStructuredAgentSession(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string
): Promise<void> {
  if (!context.sessions.has(sessionId)) {
    return
  }
  const eviction: StructuredAgentSessionEvictionContext = {
    sessionId,
    hasProviderChild: hasProviderChild(context, sessionId),
    eventSink: context.runtimeState.eventSinkFor(sessionId),
    adapter: context.deps.adapter,
    forget: () => context.sessions.delete(sessionId),
    discardSink: () => context.runtimeState.discardEventSink(sessionId),
    releaseLease: () =>
      releaseStoredStructuredAgentSessionOwner({
        store: context.deps.store,
        sessionId,
        hasProviderChild: hasProviderChild(context, sessionId),
        now: context.now()
      })
  }
  await evictStructuredAgentSession(
    eviction,
    withStructuredAgentSessionEvictionDeadline(STRUCTURED_AGENT_SESSION_EVICTION_STEPS)
  )
}

export function createStructuredAgentSessionHolds(
  context: StructuredAgentSessionLifetimeContext,
  input: {
    resume: (sessionId: string) => Promise<void>
    evict: (sessionId: string) => Promise<void>
  }
): StructuredAgentSessionHolds {
  return new StructuredAgentSessionHolds({
    resume: input.resume,
    evict: input.evict,
    hasProviderChild: (sessionId) => hasProviderChild(context, sessionId),
    isTurnActive: (sessionId) => {
      const session = context.sessions.get(sessionId)
      return session
        ? activeStructuredAgentSessionTurnId(session.journal.snapshot().items) !== null
        : false
    },
    onError: (error) => context.deps.onEventSinkError?.(error),
    ...(context.deps.releaseGraceMs === undefined ? {} : { graceMs: context.deps.releaseGraceMs })
  })
}
