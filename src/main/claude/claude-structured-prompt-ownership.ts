import {
  AgentSessionPromptAnswerRejectedError,
  AgentSessionPromptUnavailableError,
  type StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionAdapterStop } from '../native-chat/agent-session-wire/structured-agent-session-adapter-stop'
import { answerClaudePrompt, cancelClaudeTurn } from './claude-structured-control-actions'
import type { ClaudeLateDispatchSettlement } from './claude-replay-turn-resolution'
import { buildClaudePromptReply, claudePromptDismissal } from './claude-structured-prompt-replies'
import type { ClaudeSession } from './claude-structured-session-state'
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

/** The published journal's turn while it has one, else the in-memory turn (see the owner check). */
function claudeLiveTurnId(session: ClaudeSession, request: CancelInput): string | null {
  return request.resolveLiveTurnId?.() ?? session.translator?.currentTurnId ?? null
}

/**
 * A Stop that names no turn, names the live one, or names one that ended before a written
 * follow-up opened its own: the conversation asked to stop whatever this child has in flight.
 * Claude's interrupt is session-scoped, so there is no turn identity to check — only that this is
 * still the child the host judged, and that it has a turn open or a written message whose turn has
 * not opened yet (the gap before its echo, which no client can name).
 */
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
  return cancelClaudeTurn(session, timeoutMs, isCurrent, onDispatchSettledLate)
}

/** A Stop's interrupt. A card's own Cancel never comes here: `claudePromptCancelRoute` routes it. */
export async function cancelClaudeStructuredTurn(input: {
  request: CancelInput
  sessions: Map<string, ClaudeSession>
  timeoutMs?: number
  onDispatchSettledLate?: ClaudeLateDispatchSettlement
}): Promise<{ cancelled: boolean }> {
  const { request, sessions } = input
  // A Stop ends the child next, so its interrupt shares the grace with Claude's wind-down after it.
  const timeoutMs = Math.min(input.timeoutMs ?? CLAUDE_STOP_GRACE_MS, CLAUDE_STOP_GRACE_MS)
  const session = requireSession(sessions, request.sessionId)
  const acquisitionGeneration = session.acquisitionGeneration
  // Before startup lands nothing was written, so there is nothing to interrupt.
  if (request.prompt || session.startup.state === 'pending') {
    return { cancelled: false }
  }
  const requestedTurnId = request.turnId
  const liveTurnId = claudeLiveTurnId(session, request)
  // Naming the live turn asks for exactly what the conversation Stop interrupts, so a follow-up's
  // pending handover is no reason to hold it; the queue sweep settles that follow-up. With nothing
  // live, a written follow-up whose turn has not opened is one the naming client has not seen start.
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
  // Judge against the published journal, because that is the only turn a client could have been
  // shown — but only while it HAS an answer. The journal drains through a serialized async queue,
  // so a null read means the row has not landed yet, not that nothing is running; falling back to
  // the in-memory turn there keeps Stop from being gated on bookkeeping. No live turn either way
  // means nothing has published an identity this request can contradict.
  const ownsRequestedTurn = (): boolean => {
    const liveTurnId = claudeLiveTurnId(session, request)
    return liveTurnId === null ? session.dispatchSequence === 0 : liveTurnId === requestedTurnId
  }
  // The host supplies the durable latest submission; direct adapter callers fall back to
  // the current in-memory waiter so an unknown dispatch remains fenced without a latch.
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
      // Read with the result that ends it: a stopped command reports no compaction.
      if (current && compactionOwnsTurn()) {
        session.translator?.commandInterruptRequested(requestedTurnId)
      }
      return current
    },
    input.onDispatchSettledLate
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

/** The host records the dismissal (`commit`) while the claim is held. A Stop that ends the child
 *  leaves the request to end with it; only `answer` declines it, so Claude never gets a reply racing
 *  that Stop's interrupt. */
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
  // Before the commit: Claude's own cancel of the request, landing while the host writes, must
  // not write after it.
  const handBack = journalPrompts?.handOver(promptKey)
  try {
    try {
      await request.commit()
    } catch (error) {
      // Nothing recorded the card: it is Claude's again, and a withdrawal Claude made meanwhile,
      // which wrote nothing then, closes it now.
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
