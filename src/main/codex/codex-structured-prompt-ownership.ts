import {
  AgentSessionPromptAnswerRejectedError,
  AgentSessionPromptUnavailableError,
  type AgentSessionCancelOutcome,
  type StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredSessionCompaction } from '../native-chat/agent-session-wire/structured-session-compaction'
import {
  answerCodexPrompt,
  prepareCodexPromptAnswer,
  type CodexPendingPrompt,
  type CodexPreparedAnswer
} from './codex-structured-prompt-replies'
import { requireLiveCodexSession, type CodexSession } from './codex-structured-session-state'
import type { CodexStructuredTurnCancellation } from './codex-structured-turn-cancellation'

type CancelInput = Parameters<StructuredAgentSessionAdapter['cancelTurn']>[0]
type AnswerInput = Parameters<StructuredAgentSessionAdapter['answerPrompt']>[0]

/** How long a Stop waits for Codex to open the turn it answered a send into. Under the quit
 *  path's eviction budget, which a close or quit queued behind the Stop spends. */
export const CODEX_STOP_TURN_OPEN_WAIT_MS = 5_000

/**
 * A Stop that names no turn: interrupt the turn the journal shows, or else the one Codex reported
 * started and not yet ended, which the journal can trail by a publish, or else the one Codex
 * answered a send into, once it opens.
 */
async function cancelCodexConversation(
  input: Parameters<typeof cancelCodexStructuredTurn>[0],
  session: CodexSession
): Promise<AgentSessionCancelOutcome> {
  const { request, sessions, compactions, cancellation } = input
  const liveTurnId = request.resolveLiveTurnId?.() ?? null
  // A turn the journal shows that Codex has not started yet (a compaction's) has nothing to stop.
  const turnId =
    liveTurnId === null
      ? ([...(session.activeTurnIds ?? [])].at(-1) ?? (await openedAnsweredTurn(session)))
      : compactions.providerTurnId(request.sessionId, liveTurnId)
  if (!turnId) {
    return { cancelled: false }
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

/** The turn Codex answered a send into and has not opened yet, once it opens; null when it ends,
 *  the thread stops running or the child exits first, or the wait runs out. */
async function openedAnsweredTurn(session: CodexSession): Promise<string | null> {
  const openTurnIds = session.activeTurnIds ?? new Set<string>()
  const answered = session.dispatchEchoes.answeredUnopenedTurn(session.threadId, openTurnIds)
  if (!answered) {
    return null
  }
  // Codex refuses an interrupt before it opens the turn.
  await session.turnOpenWaits.wait(answered, CODEX_STOP_TURN_OPEN_WAIT_MS)
  return session.activeTurnIds?.has(answered) ? answered : null
}

export async function cancelCodexStructuredTurn(input: {
  request: CancelInput
  sessions: Map<string, CodexSession>
  compactions: StructuredSessionCompaction
  cancellation: CodexStructuredTurnCancellation
}): Promise<AgentSessionCancelOutcome> {
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

function prepareCodexAnswer(
  prompt: CodexPendingPrompt,
  response: AnswerInput['response']
): CodexPreparedAnswer {
  try {
    return prepareCodexPromptAnswer(prompt, response)
  } catch (error) {
    throw new AgentSessionPromptAnswerRejectedError(
      error instanceof Error ? error.message : String(error)
    )
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
    const prepared = prepareCodexAnswer(claim.prompt, request.response)
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
    answerCodexPrompt(session.prompts, session.connection, claim, prepared)
  } catch (error) {
    session.prompts.releaseClaim(claim)
    throw error
  }
}
