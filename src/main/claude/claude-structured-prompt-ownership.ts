import {
  AgentSessionPromptAnswerRejectedError,
  AgentSessionPromptUnavailableError,
  type StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredSessionCompaction } from '../native-chat/agent-session-wire/structured-session-compaction'
import { CLAUDE_DEFAULT_REQUEST_TIMEOUT_MS } from './claude-agent-sdk-control-requests'
import {
  answerClaudePrompt,
  cancelClaudeTurn,
  supportsClaudeQueuedInterruptCancellation
} from './claude-structured-control-actions'
import type { ClaudeLateDispatchSettlement } from './claude-structured-dispatch'
import { buildClaudePromptReply } from './claude-structured-prompt-replies'
import type { ClaudeSession } from './claude-structured-session-state'
import type { ClaudePendingPrompt } from './claude-prompt-registry'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'

/** Conservative user-facing window: below the 30s control deadline, trading
 * residual slow-pump risk for ensuring delivery bookkeeping cannot block Stop indefinitely. */
export const CLAUDE_DISPATCH_ADMISSION_TIMEOUT_MS = 3_000
const CLAUDE_DISPATCH_ADMISSION_POLL_MS = 50

type CancelInput = Parameters<StructuredAgentSessionAdapter['cancelTurn']>[0]
type AnswerInput = Parameters<StructuredAgentSessionAdapter['answerPrompt']>[0]

export function admitClaudePromptCancellation(session: ClaudeSession, promptKey: string): boolean {
  const admission = session.translator?.journalPrompts.cancel(promptKey)
  return admission?.accepted ?? true
}

function waitForClaudePromptCancellation(
  observed: Promise<void>,
  timeoutMs = CLAUDE_DEFAULT_REQUEST_TIMEOUT_MS
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('Claude prompt cancellation abort was not observed')),
      timeoutMs
    )
    timer.unref?.()
  })
  return Promise.race([observed, deadline]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
}

function requireSession(sessions: Map<string, ClaudeSession>, sessionId: string): ClaudeSession {
  const session = sessions.get(sessionId)
  if (!session) {
    throw new Error(`no live claude stream-json session for ${sessionId}`)
  }
  return session
}

function waitForClaudeDispatchAdmission(
  admitted: () => boolean,
  timeoutMs = CLAUDE_DISPATCH_ADMISSION_TIMEOUT_MS
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let deadline: ReturnType<typeof setTimeout> | null = null
    let poll: ReturnType<typeof setInterval> | null = null
    const finish = (value: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (deadline) {
        clearTimeout(deadline)
      }
      if (poll) {
        clearInterval(poll)
      }
      resolve(value)
    }
    const check = (): void => {
      if (admitted()) {
        finish(true)
      }
    }
    deadline = setTimeout(() => finish(false), timeoutMs)
    poll = setInterval(check, CLAUDE_DISPATCH_ADMISSION_POLL_MS)
    check()
    deadline.unref?.()
    poll.unref?.()
  })
}

export async function cancelClaudeStructuredTurn(input: {
  request: CancelInput
  sessions: Map<string, ClaudeSession>
  compactions: StructuredSessionCompaction
  timeoutMs?: number
  admitPromptCancellation: (session: ClaudeSession, promptKey: string) => boolean
  onDispatchSettledLate?: ClaudeLateDispatchSettlement
}): Promise<{ cancelled: boolean }> {
  const { request, sessions, compactions, timeoutMs } = input
  const session = requireSession(sessions, request.sessionId)
  const acquisitionGeneration = session.acquisitionGeneration
  const prompt = request.prompt
  // Before startup lands nothing was written, so there is nothing to interrupt.
  if (!prompt && session.startup.state === 'pending') {
    return { cancelled: false }
  }
  if (prompt && session.fence !== request.fence) {
    return { cancelled: false }
  }
  const claim = prompt ? session.prompts.claimBound(prompt.itemId, request.turnId) : null
  if (prompt && !claim) {
    return { cancelled: false }
  }
  const cancellationObserved = claim ? session.prompts.observeCancellation(claim) : null
  if (claim && !cancellationObserved) {
    session.prompts.releaseClaim(claim)
    return { cancelled: false }
  }
  // Judge against the published journal, because that is the only turn a client could have been
  // shown — but only while it HAS an answer. The journal drains through a serialized async queue,
  // so a null read means the row has not landed yet, not that nothing is running; falling back to
  // the in-memory turn there keeps Stop from being gated on bookkeeping. No live turn either way
  // means nothing has published an identity this request can contradict.
  const ownsRequestedTurn = (): boolean => {
    const liveTurnId = request.resolveLiveTurnId?.() ?? session.translator?.currentTurnId ?? null
    return liveTurnId === null ? session.dispatchSequence === 0 : liveTurnId === request.turnId
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
  // Prompt cancellation has a separate callback-settlement contract, so only a provider with
  // cancelQueued can release its uncertain queued send. Ordinary Stop gets a bounded escape below.
  const dispatchAdmissionAllowsCancellation = (): boolean =>
    dispatchAdmissionIsCurrent() ||
    (Boolean(prompt) && supportsClaudeQueuedInterruptCancellation(session))
  const compactionOwnsTurn = (): boolean => compactions.ownsTurn(request.sessionId, request.turnId)
  const currentDispatchHasRetiredWaiter = (): boolean =>
    session.retiredDispatchWaiters.some(
      (waiter) => waiter.dispatchSequence === session.dispatchSequence
    )
  let dispatchAdmissionExpired = false
  if (
    !prompt &&
    !compactionOwnsTurn() &&
    !dispatchAdmissionAllowsCancellation() &&
    (request.dispatchStatus !== undefined || currentDispatchHasRetiredWaiter())
  ) {
    dispatchAdmissionExpired = !(await waitForClaudeDispatchAdmission(
      dispatchAdmissionAllowsCancellation
    ))
  }
  const isCurrent = (): boolean =>
    sessions.get(request.sessionId) === session &&
    session.fence === request.fence &&
    session.acquisitionGeneration === acquisitionGeneration &&
    (claim && prompt
      ? ownsRequestedTurn() &&
        session.prompts.ownsBoundClaim(claim, prompt.itemId, request.turnId) &&
        (dispatchAdmissionAllowsCancellation() || dispatchAdmissionExpired)
      : compactionOwnsTurn() ||
        (ownsRequestedTurn() &&
          (dispatchAdmissionAllowsCancellation() || dispatchAdmissionExpired)))
  let interruptConfirmed = false
  try {
    const result = await cancelClaudeTurn(
      session,
      timeoutMs,
      isCurrent,
      input.onDispatchSettledLate
    )
    if (result.cancelled && claim && cancellationObserved) {
      interruptConfirmed = true
      await waitForClaudePromptCancellation(cancellationObserved, timeoutMs)
      if (!input.admitPromptCancellation(session, claim.found.prompt.promptKey)) {
        throw new Error(`Claude prompt cancellation lifecycle was not admitted for ${claim.itemId}`)
      }
    } else if (claim) {
      session.prompts.releaseClaim(claim)
    }
    return result
  } catch (error) {
    if (claim && !interruptConfirmed) {
      session.prompts.releaseClaim(claim)
    }
    throw error
  }
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
