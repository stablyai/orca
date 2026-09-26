import {
  AgentSessionPromptUnavailableError,
  type StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredSessionCompaction } from '../native-chat/agent-session-wire/structured-session-compaction'
import { answerCodexPrompt } from './codex-structured-prompt-replies'
import { requireLiveCodexSession, type CodexSession } from './codex-structured-session-state'
import type { CodexStructuredTurnCancellation } from './codex-structured-turn-cancellation'

type CancelInput = Parameters<StructuredAgentSessionAdapter['cancelTurn']>[0]
type AnswerInput = Parameters<StructuredAgentSessionAdapter['answerPrompt']>[0]

/**
 * A Stop that names no turn: interrupt the turn the journal shows, or else the one the latest
 * `turn/start` answered with — the gap before `turn/started` lands, which no client can name. A
 * `turn/start` still unanswered is never seen here: its handover holds the session's queue, which
 * Stop waits in. One that failed left no turn id, so nothing is interrupted.
 */
function cancelCodexConversation(
  input: Parameters<typeof cancelCodexStructuredTurn>[0],
  session: CodexSession
): Promise<{ cancelled: boolean }> {
  const { request, sessions, compactions, cancellation } = input
  const liveTurnId = request.resolveLiveTurnId?.() ?? null
  const turnId =
    (liveTurnId === null ? null : compactions.providerTurnId(request.sessionId, liveTurnId)) ??
    session.startedTurnId
  if (!turnId) {
    return Promise.resolve({ cancelled: false })
  }
  const acquisitionGeneration = session.acquisitionGeneration
  return cancellation.cancel(
    session,
    session.threadId,
    turnId,
    () =>
      sessions.get(request.sessionId) === session &&
      !session.ended &&
      session.fence === request.fence &&
      session.acquisitionGeneration === acquisitionGeneration
  )
}

export async function cancelCodexStructuredTurn(input: {
  request: CancelInput
  sessions: Map<string, CodexSession>
  compactions: StructuredSessionCompaction
  cancellation: CodexStructuredTurnCancellation
}): Promise<{ cancelled: boolean }> {
  const { request, sessions, compactions, cancellation } = input
  const session = requireLiveCodexSession(sessions, request.sessionId)
  const prompt = request.prompt
  const requestedTurnId = request.turnId
  if (requestedTurnId === undefined) {
    return prompt ? { cancelled: false } : cancelCodexConversation(input, session)
  }
  const turnId = compactions.providerTurnId(request.sessionId, requestedTurnId)
  if (!turnId) {
    return { cancelled: false }
  }
  if (!prompt) {
    return cancellation.cancel(session, session.threadId, turnId)
  }
  if (session.fence !== request.fence) {
    return { cancelled: false }
  }
  const acquisitionGeneration = session.acquisitionGeneration
  const claim = session.prompts.claimBound(prompt.itemId)
  const promptTurnId = claim?.prompt.turnId
  if (!claim || !promptTurnId) {
    if (claim) {
      session.prompts.releaseClaim(claim)
    }
    return { cancelled: false }
  }
  const isCurrent = (): boolean =>
    sessions.get(request.sessionId) === session &&
    !session.ended &&
    session.fence === request.fence &&
    session.acquisitionGeneration === acquisitionGeneration &&
    compactions.providerTurnId(request.sessionId, requestedTurnId) === turnId &&
    session.prompts.ownsBoundClaim(claim, prompt.itemId, claim.prompt.threadId, promptTurnId)
  let interruptConfirmed = false
  try {
    const result = await cancellation.cancel(
      session,
      claim.prompt.threadId,
      promptTurnId,
      isCurrent,
      () => {
        interruptConfirmed = true
        return session.translator?.cancelPrompt(prompt.itemId) ?? { accepted: true }
      }
    )
    if (!result.cancelled) {
      session.prompts.releaseClaim(claim)
    }
    return result
  } catch (error) {
    if (!interruptConfirmed) {
      session.prompts.releaseClaim(claim)
    }
    throw error
  }
}

export async function answerCodexStructuredPrompt(input: {
  request: AnswerInput
  sessions: Map<string, CodexSession>
}): Promise<void> {
  const { request, sessions } = input
  const session = sessions.get(request.sessionId)
  if (!session || session.ended || session.fence !== request.fence) {
    throw new AgentSessionPromptUnavailableError(request.itemId)
  }
  const acquisitionGeneration = session.acquisitionGeneration
  const claim = session.prompts.claim(request.itemId, request.kind)
  if (!claim) {
    throw new AgentSessionPromptUnavailableError(request.itemId)
  }
  try {
    await request.commit()
    if (
      sessions.get(request.sessionId) !== session ||
      session.ended ||
      session.fence !== request.fence ||
      session.acquisitionGeneration !== acquisitionGeneration ||
      !session.prompts.ownsClaim(claim)
    ) {
      throw new AgentSessionPromptUnavailableError(request.itemId)
    }
    session.translator?.resolvePrompt(request.itemId)
    answerCodexPrompt(session.prompts, session.connection, claim, request.optionId)
  } catch (error) {
    session.prompts.releaseClaim(claim)
    throw error
  }
}
