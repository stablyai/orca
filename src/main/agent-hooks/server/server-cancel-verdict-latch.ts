import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { AgentMainAgentStatus } from '../../../shared/agent-status-types'
import { INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS } from './server-constants'
import { foldMainAgentWithRowChildWork } from './server-row-child-work-fold'
import { isToolProgressWorkingAfterInterrupt } from './server-status-identity'
import type { EnrichedAgentHookEventPayload } from './server-types'

export type CancelVerdictLatchDecision =
  | { hold: true }
  | { hold: false; event: AgentHookEventPayload }

const HOLD: CancelVerdictLatchDecision = { hold: true }

/** Derived from the row, never stored: a row whose main agent reads cancelled (or, from a host too
 *  old to publish `mainAgent`, a done row flagged interrupted). */
function isCancelVerdictLatched(previous: EnrichedAgentHookEventPayload): boolean {
  const mainAgent = previous.payload.mainAgent
  return mainAgent
    ? mainAgent.outcome === 'cancellation'
    : previous.payload.state === 'done' && previous.payload.interrupted === true
}

/** An event that restates child work can be re-folded with it; one that carries none has nothing to add. */
function carriesChildWork(event: AgentHookEventPayload): boolean {
  return event.payload.subagents !== undefined || event.claudeRunningNonAgentTask !== undefined
}

function refoldUnderLatchedMainAgent(
  previous: EnrichedAgentHookEventPayload,
  latched: AgentMainAgentStatus,
  incoming: AgentHookEventPayload
): AgentHookEventPayload {
  // Why: a child's own attention state is child work, not the main agent's; only `working` is the stale restatement.
  const resolved = foldMainAgentWithRowChildWork(
    incoming.payload.state === 'working' ? latched.state : incoming.payload.state,
    {
      claudeRunningNonAgentTask:
        incoming.claudeRunningNonAgentTask ?? previous.claudeRunningNonAgentTask,
      payload: incoming.payload
    }
  )
  const {
    workingMode: _workingMode,
    interrupted: _interrupted,
    turnCompletedAt: _turnCompletedAt,
    ...rest
  } = incoming.payload
  return {
    ...incoming,
    payload: {
      ...rest,
      state: resolved.stateName,
      ...(resolved.workingMode ? { workingMode: resolved.workingMode } : {}),
      ...(resolved.stateName === 'done' ? { interrupted: true } : {}),
      mainAgent: latched
    }
  }
}

function keepLatchedCancellation(incoming: AgentHookEventPayload): AgentHookEventPayload {
  const { interrupted: _interrupted, turnCompletedAt: _turnCompletedAt, ...rest } = incoming.payload
  return {
    ...incoming,
    payload: {
      ...rest,
      ...(rest.state === 'done' ? { interrupted: true } : {}),
      ...(rest.mainAgent ? { mainAgent: { ...rest.mainAgent, outcome: 'cancellation' } } : {})
    }
  }
}

/** A main agent's own prompt submission always opens a turn, including a harness-injected one that
 *  keeps the cached prompt (the task notification Claude starts when background work ends). */
function opensNewTurn(event: AgentHookEventPayload): boolean {
  return (
    event.hookEventName === 'SessionStart' ||
    (event.hookEventName === 'UserPromptSubmit' &&
      event.toolAgentId === undefined &&
      event.isReplay !== true)
  )
}

/** A child's own event: one naming its agent id, or a teammate's idle, which names it by `teammate_name` only. */
function isChildAttributed(event: AgentHookEventPayload): boolean {
  return event.toolAgentId !== undefined || event.hookEventName === 'TeammateIdle'
}

/** A child restates its listener's cached prompt, which a restarted relay has lost; empty there is unknown, not another turn. */
function restatesAnotherPrompt(
  previous: EnrichedAgentHookEventPayload,
  incoming: AgentHookEventPayload
): boolean {
  const prompt = incoming.payload.prompt
  return prompt !== previous.payload.prompt && (prompt !== '' || !isChildAttributed(incoming))
}

/**
 * The store's hold on a cancel verdict against restatements that predate it: a relay never learns
 * of the cancel the desktop infers, and TUIs emit late same-turn hooks after Ctrl+C. The latch dies
 * on the provider's own verdict (any settled `mainAgent`, except a failure, which ends the same
 * turn the user already stopped) or a new turn (another prompt, an
 * explicit prompt, a prompt submission, a session start). Child-attributed and replayed events keep the latched main
 * agent and are re-folded with their own child evidence; late main agent work is held.
 */
export function resolveCancelVerdictLatch(
  previous: EnrichedAgentHookEventPayload | undefined,
  incoming: AgentHookEventPayload,
  now: number
): CancelVerdictLatchDecision {
  const apply: CancelVerdictLatchDecision = { hold: false, event: incoming }
  if (
    !previous ||
    !isCancelVerdictLatched(previous) ||
    previous.payload.agentType !== incoming.payload.agentType ||
    restatesAnotherPrompt(previous, incoming) ||
    opensNewTurn(incoming)
  ) {
    return apply
  }
  if (incoming.payload.mainAgent?.state === 'done') {
    // Why: the user's stop is the turn's verdict; a provider error landing after it ends the same turn.
    return incoming.payload.mainAgent.outcome === 'failure'
      ? { hold: false, event: keepLatchedCancellation(incoming) }
      : apply
  }
  const latched = previous.payload.mainAgent
  // Why: Codex's combine is not this fold; its child events already come reconciled against main's marked record.
  if (
    latched &&
    incoming.payload.agentType !== 'codex' &&
    incoming.payload.state !== 'done' &&
    (isChildAttributed(incoming) || incoming.isReplay === true) &&
    carriesChildWork(incoming)
  ) {
    return { hold: false, event: refoldUnderLatchedMainAgent(previous, latched, incoming) }
  }
  const withinWindow = now - previous.receivedAt <= INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS
  if (incoming.payload.state === 'done') {
    return previous.payload.state === 'done' && withinWindow ? HOLD : apply
  }
  if (
    incoming.payload.state === 'working' &&
    (incoming.isReplay === true ||
      isToolProgressWorkingAfterInterrupt(incoming) ||
      (incoming.hasExplicitPrompt !== true && withinWindow))
  ) {
    return HOLD
  }
  return apply
}
