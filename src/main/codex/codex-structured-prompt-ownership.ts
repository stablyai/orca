import {
  AgentSessionPromptAnswerRejectedError,
  AgentSessionPromptUnavailableError,
  type AgentSessionCancelOutcome,
  type StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  answerCodexPrompt,
  prepareCodexPromptAnswer,
  type CodexPendingPrompt,
  type CodexPreparedAnswer
} from './codex-structured-prompt-replies'
import { requireLiveCodexSession, type CodexSession } from './codex-structured-session-state'
import { interruptCodexTurn } from './codex-structured-turn-cancellation'
import { codexStopTarget, interruptOpeningCodexTurn } from './codex-structured-turn-open-wait'
import { stopCodexGoal } from './codex-structured-goal-stop'
import { CODEX_STOP_GRACE_MS } from './codex-request-end-wait'

type CancelInput = Parameters<StructuredAgentSessionAdapter['cancelTurn']>[0]
type AnswerInput = Parameters<StructuredAgentSessionAdapter['answerPrompt']>[0]

/** Map command-owned journal turns to the provider turn Stop must interrupt. */
function providerTurnId(session: CodexSession, turnId: string): string | undefined {
  return session.translator ? session.translator.commandProviderTurnId(turnId) : turnId
}

/** An unrecovered send may still open a turn that Stop cannot yet name. */
function sendInDoubt(dispatchStatus: CancelInput['dispatchStatus']): boolean {
  return dispatchStatus?.state === 'unknown' && !dispatchStatus.recovered
}

function stoppedTurn(
  outcome: AgentSessionCancelOutcome,
  turnId: string
): AgentSessionCancelOutcome {
  return outcome.cancelled ? { ...outcome, turnId } : outcome
}

/** Fall back to provider bookkeeping when the journal trails an opening turn. */
async function cancelCodexConversation(
  input: Parameters<typeof cancelCodexStructuredTurn>[0],
  session: CodexSession
): Promise<AgentSessionCancelOutcome> {
  const { request, sessions, requestTimeoutMs } = input
  const stoppedAt = request.stoppedAt ?? Date.now()
  const generation = session.acquisitionGeneration
  const liveTurnId = request.resolveLiveTurnId?.() ?? null
  // A command's journal turn can exist before its interruptible provider turn.
  const target = liveTurnId === null ? codexStopTarget(session) : { turnId: liveTurnId }
  // Opening waits can outlive their session; recheck ownership after awaiting.
  const current = (): boolean =>
    sessions.get(request.sessionId) === session &&
    !session.ended &&
    session.fence === request.fence &&
    session.acquisitionGeneration === generation
  if (!current()) {
    return { cancelled: false }
  }
  if (target === null) {
    return sendInDoubt(request.dispatchStatus)
      ? { cancelled: false, refusal: { turnMayOpen: true } }
      : { cancelled: false }
  }
  const journalTurnId = 'opening' in target ? target.opening : target.turnId
  const turnId = liveTurnId === null ? journalTurnId : providerTurnId(session, liveTurnId)
  if (!turnId) {
    return { cancelled: false }
  }
  const interrupt = () =>
    interruptCodexTurn({ session, threadId: session.threadId, turnId, requestTimeoutMs, stoppedAt })
  if (!('opening' in target)) {
    return stoppedTurn(await interrupt(), journalTurnId)
  }
  return stoppedTurn(
    await interruptOpeningCodexTurn(
      session,
      turnId,
      interrupt,
      current,
      stoppedAt + CODEX_STOP_GRACE_MS
    ),
    journalTurnId
  )
}

export async function cancelCodexStructuredTurn(input: {
  request: CancelInput
  sessions: Map<string, CodexSession>
  requestTimeoutMs?: number
}): Promise<AgentSessionCancelOutcome> {
  const { request, sessions, requestTimeoutMs } = input
  const session = requireLiveCodexSession(sessions, request.sessionId)
  if (request.stoppedAt !== undefined && !request.prompt) {
    const generation = session.acquisitionGeneration
    return stopCodexGoal({
      session,
      stoppedAt: request.stoppedAt,
      timeoutMs: requestTimeoutMs,
      current: () =>
        sessions.get(request.sessionId) === session &&
        !session.ended &&
        session.fence === request.fence &&
        session.acquisitionGeneration === generation,
      interrupt: () => cancelCodexConversation(input, session)
    })
  }
  const prompt = request.prompt
  const requestedTurnId = request.turnId
  if (requestedTurnId === undefined) {
    return prompt ? { cancelled: false } : cancelCodexConversation(input, session)
  }
  const turnId = providerTurnId(session, requestedTurnId)
  if (!turnId) {
    return { cancelled: false }
  }
  if (!prompt) {
    return stoppedTurn(
      await interruptCodexTurn({
        session,
        threadId: session.threadId,
        turnId,
        requestTimeoutMs,
        stoppedAt: request.stoppedAt ?? Date.now()
      }),
      requestedTurnId
    )
  }
  if (session.fence !== request.fence) {
    return { cancelled: false }
  }
  const claim = session.prompts.claimBound(prompt.itemId)
  const promptTurnId = claim?.prompt.turnId
  if (!claim || !promptTurnId) {
    if (claim) {
      session.prompts.releaseClaim(claim)
    }
    return { cancelled: false }
  }
  let interruptConfirmed = false
  try {
    const result = await interruptCodexTurn({
      session,
      threadId: claim.prompt.threadId,
      turnId: promptTurnId,
      requestTimeoutMs,
      onConfirmed: () => {
        interruptConfirmed = true
        return session.translator?.cancelPrompt(prompt.itemId) ?? { accepted: true }
      }
    })
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
