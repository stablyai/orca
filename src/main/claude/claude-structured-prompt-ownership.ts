import {
  AgentSessionPromptAnswerRejectedError,
  AgentSessionPromptUnavailableError,
  type StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionAdapterStop } from '../native-chat/agent-session-wire/structured-agent-session-adapter-stop'
import { answerClaudePrompt, cancelClaudeTurn } from './claude-structured-control-actions'
import type { ClaudeLateDispatchSettlement } from './claude-replay-turn-resolution'
import { buildClaudePromptReply, claudePromptDismissal } from './claude-structured-prompt-replies'
import type { ClaudeSession } from './structured/claude-structured-session-state'
import type { ClaudePendingPrompt } from './claude-prompt-registry'
import { CLAUDE_STOP_GRACE_MS } from './claude-request-end-wait'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'

type CancelInput = Parameters<StructuredAgentSessionAdapter['cancelTurn']>[0]
type AnswerInput = Parameters<StructuredAgentSessionAdapter['answerPrompt']>[0]

function requireSession(sessions: Map<string, ClaudeSession>, sessionId: string): ClaudeSession {
  const session = sessions.get(sessionId)
  if (!session) {
    throw new Error(`no live claude stream-json session for ${sessionId}`)
  }
  return session
}

/** Fall back to memory when the journal has not admitted a turn row. */
function claudeLiveTurnId(session: ClaudeSession, request: CancelInput): string | null {
  return request.resolveLiveTurnId?.() ?? session.translator?.currentTurnId ?? null
}

/** Session-scoped interrupts also cover written messages awaiting their first turn echo. */
function cancelClaudeConversation(
  session: ClaudeSession,
  sessions: Map<string, ClaudeSession>,
  request: CancelInput,
  timeoutMs: number | undefined,
  onDispatchSettledLate: ClaudeLateDispatchSettlement | undefined
): Promise<{ cancelled: boolean }> {
  const acquisitionGeneration = session.acquisitionGeneration
  const isCurrent = (): boolean =>
    sessions.get(request.sessionId) === session &&
    session.fence === request.fence &&
    session.acquisitionGeneration === acquisitionGeneration &&
    (claudeLiveTurnId(session, request) !== null || session.dispatchWaiters.length > 0)
  return cancelClaudeTurn(
    session,
    timeoutMs,
    isCurrent,
    onDispatchSettledLate,
    request.stoppedAt ?? Date.now()
  )
}

export async function cancelClaudeStructuredTurn(input: {
  request: CancelInput
  sessions: Map<string, ClaudeSession>
  timeoutMs?: number
  onDispatchSettledLate?: ClaudeLateDispatchSettlement
}): Promise<{ cancelled: boolean }> {
  const { request, sessions } = input
  // Interrupt and child shutdown share the Stop grace period.
  const timeoutMs = Math.min(input.timeoutMs ?? CLAUDE_STOP_GRACE_MS, CLAUDE_STOP_GRACE_MS)
  const session = requireSession(sessions, request.sessionId)
  const acquisitionGeneration = session.acquisitionGeneration
  if (request.prompt) {
    return { cancelled: false }
  }
  const requestedTurnId = request.turnId
  const liveTurnId = claudeLiveTurnId(session, request)
  // A conversation Stop also sweeps queued follow-ups and written messages awaiting an echo.
  if (
    requestedTurnId === undefined ||
    (session.translator?.commandTurnId !== requestedTurnId &&
      (liveTurnId === requestedTurnId ||
        (liveTurnId === null && session.dispatchWaiters.length > 0)))
  ) {
    return cancelClaudeConversation(
      session,
      sessions,
      request,
      timeoutMs,
      input.onDispatchSettledLate
    )
  }
  // Prefer the client-visible turn; absent journal rows must not block Stop under backpressure.
  const ownsRequestedTurn = (): boolean => {
    const liveTurnId = claudeLiveTurnId(session, request)
    return liveTurnId === null ? session.dispatchSequence === 0 : liveTurnId === requestedTurnId
  }
  // Direct callers lack durable admission status; retain fencing for unacknowledged dispatches.
  const dispatchAdmissionIsCurrent = (): boolean =>
    request.dispatchStatus
      ? request.dispatchStatus.state === 'accepted' ||
        request.dispatchStatus.state === 'rejected' ||
        (request.dispatchStatus.state === 'unknown' && request.dispatchStatus.recovered)
      : session.dispatchSequence === 0 ||
        ![...session.dispatchWaiters, ...session.retiredDispatchWaiters].some(
          (waiter) => waiter.dispatchSequence === session.dispatchSequence
        )
  const compactionOwnsTurn = (): boolean =>
    session.translator !== null && session.translator.commandTurnId === requestedTurnId
  return cancelClaudeTurn(
    session,
    timeoutMs,
    () => {
      const current =
        sessions.get(request.sessionId) === session &&
        session.fence === request.fence &&
        session.acquisitionGeneration === acquisitionGeneration &&
        (compactionOwnsTurn() || (ownsRequestedTurn() && dispatchAdmissionIsCurrent()))
      // Suppress compaction reporting when the interrupted command ends.
      if (current && compactionOwnsTurn()) {
        session.translator?.commandInterruptRequested(requestedTurnId)
      }
      return current
    },
    input.onDispatchSettledLate,
    request.stoppedAt ?? Date.now()
  )
}

function prepareClaudePromptReply(
  prompt: ClaudePendingPrompt,
  response: AnswerInput['response']
): PermissionResult {
  try {
    return buildClaudePromptReply(prompt, response)
  } catch (error) {
    throw new AgentSessionPromptAnswerRejectedError(
      error instanceof Error ? error.message : String(error)
    )
  }
}

export async function answerClaudeStructuredPrompt(input: {
  request: AnswerInput
  sessions: Map<string, ClaudeSession>
}): Promise<void> {
  const { request, sessions } = input
  const session = sessions.get(request.sessionId)
  if (!session || session.fence !== request.fence) {
    throw new AgentSessionPromptUnavailableError(request.itemId)
  }
  const acquisitionGeneration = session.acquisitionGeneration
  const claim = session.prompts.claim(request.itemId, request.kind)
  if (!claim) {
    throw new AgentSessionPromptUnavailableError(request.itemId)
  }
  try {
    const reply = prepareClaudePromptReply(claim.found.prompt, request.response)
    await request.commit()
    if (
      sessions.get(request.sessionId) !== session ||
      session.fence !== request.fence ||
      session.acquisitionGeneration !== acquisitionGeneration ||
      !session.prompts.ownsClaim(claim)
    ) {
      throw new AgentSessionPromptUnavailableError(request.itemId)
    }
    await answerClaudePrompt(session, claim, reply)
  } catch (error) {
    session.prompts.releaseClaim(claim)
    throw error
  }
}

/** Hold the claim through commit; only `answer` sends a denial, avoiding a race with Stop. */
export async function dismissClaudeStructuredPrompt(input: {
  request: Parameters<NonNullable<StructuredAgentSessionAdapterStop['dismissPrompt']>>[0]
  sessions: Map<string, ClaudeSession>
}): Promise<void> {
  const { request, sessions } = input
  const session = sessions.get(request.sessionId)
  const claim = session?.fence === request.fence ? session.prompts.claim(request.itemId) : null
  if (!session || !claim) {
    throw new AgentSessionPromptUnavailableError(request.itemId)
  }
  const { promptKey } = claim.found.prompt
  const journalPrompts = session.translator?.journalPrompts
  // Transfer ownership before commit so provider cancellation cannot overwrite the host record.
  const handBack = journalPrompts?.handOver(promptKey)
  try {
    try {
      await request.commit()
    } catch (error) {
      // Restore ownership and apply any provider cancellation received during the failed commit.
      handBack?.()
      if (!session.prompts.find(request.itemId)) {
        journalPrompts?.cancel(promptKey)
      }
      throw error
    }
    if (request.answer && session.prompts.ownsClaim(claim)) {
      await answerClaudePrompt(session, claim, claudePromptDismissal(claim.found.prompt))
    }
  } finally {
    session.prompts.releaseClaim(claim)
  }
}

/** Clear child waiting before closing its card so status never waits on a resolved prompt. */
export function settleClaudePromptFreeingChild<R extends { commit: () => Promise<void> }>(
  input: { request: R; sessions: Map<string, ClaudeSession>; free: () => void },
  settle: (input: { request: R; sessions: Map<string, ClaudeSession> }) => Promise<void>
): Promise<void> {
  const { request, sessions, free } = input
  const commit = async (): Promise<void> => {
    free()
    await request.commit()
  }
  return settle({ request: { ...request, commit }, sessions }).finally(free)
}
