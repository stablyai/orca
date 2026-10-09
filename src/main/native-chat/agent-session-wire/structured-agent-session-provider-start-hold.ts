// One rule for every agent: an operation only the agent's protocol session can perform (a rewind, a
// goal, the rewind recovery a send needs) never reaches a child still proving its start, which has
// no protocol session yet. Its preparation answers `providerStarting` while the child starts; the
// call then waits here, outside the session's queue, because the start's own step runs in that
// queue, and is decided afresh once the start is proven. A start that ends unproven fails the call.

import {
  refuse,
  refuseUnclassified,
  type AgentSessionMutationResult,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import { agentSessionWriteNoticeEnglish } from '../../../shared/agent-session-refusal-notice'
import {
  providerChildStartSettled,
  type StructuredAgentSessionChildStartOutcome
} from './structured-agent-session-provider-child'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { STRUCTURED_AGENT_SESSION_STARTUP_CEILING_MS } from './structured-agent-session-startup-attempt-contract'

const PROVIDER_STARTING: AgentSessionWireRefusal = refuse(
  'agent_session_operation_invalid',
  { reason: 'providerStarting' },
  'The agent is still starting.'
)

/** The refusal a preparation answers with while the session's child has not proven its start. */
export function refuseWhileProviderStarting(
  session: Pick<StructuredAgentSessionHostSession, 'child'> | undefined
): { ok: false; refusal: AgentSessionWireRefusal } | null {
  return session?.child?.phase === 'starting' ? { ok: false, refusal: PROVIDER_STARTING } : null
}

/** The startup limit always ends a start; the ceiling only bounds a wait nothing else would. */
async function awaitProviderChildStart(
  session: Pick<StructuredAgentSessionHostSession, 'child'> | undefined,
  ceilingMs: number = STRUCTURED_AGENT_SESSION_STARTUP_CEILING_MS
): Promise<StructuredAgentSessionChildStartOutcome | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ceilingMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([providerChildStartSettled(session), timedOut])
  } finally {
    clearTimeout(timer)
  }
}

function heldForStart<T>(result: AgentSessionMutationResult<T>): boolean {
  return !result.ok && result.refusal.details?.reason === 'providerStarting'
}

/** Runs `run`, and once more after the start it found under way is proven. Never called inside the
 *  session's queue. A second start found starting is refused, never waited on again. */
export async function runAfterProviderStart<T>(
  context: {
    sessions: ReadonlyMap<string, Pick<StructuredAgentSessionHostSession, 'child'>>
    deps: Pick<StructuredAgentSessionHostDeps, 'startupLimits'>
  },
  sessionId: string,
  run: () => Promise<AgentSessionMutationResult<T>>
): Promise<AgentSessionMutationResult<T>> {
  const first = await run()
  if (!heldForStart(first)) {
    return first
  }
  const started = await awaitProviderChildStart(
    context.sessions.get(sessionId),
    context.deps.startupLimits?.ceilingMs
  )
  if (started === 'timeout') {
    return first
  }
  if (started === 'ended') {
    // The start's own failure is the chat's to show; the call says only that it did not start.
    return {
      ok: false,
      refusal: refuseUnclassified(
        'agent_session_owner_restart_failed',
        agentSessionWriteNoticeEnglish(['restartFailed'])
      )
    }
  }
  return run()
}
