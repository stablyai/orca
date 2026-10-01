import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudePromptClaim } from './claude-structured-prompt-replies'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import { ClaudeControlRequestTimeoutError } from './claude-agent-sdk-control-requests'
import { settleCancelledClaudeDispatchWaiters } from './claude-structured-dispatch'
import type { ClaudeLateDispatchSettlement } from './claude-replay-turn-resolution'
import type { ClaudeSession } from './claude-structured-session-state'
import type { StructuredAgentSessionStopCause } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

const INTERRUPT_CANCEL_QUEUED_CAPABILITY = 'interrupt_cancel_queued_v1'

export function supportsClaudeQueuedInterruptCancellation(session: ClaudeSession): boolean {
  return session.capabilities.includes(INTERRUPT_CANCEL_QUEUED_CAPABILITY)
}

export type ClaudeTurnCancellationGuard = () => boolean

/**
 * Interrupt the running turn, then make sure no queued async user message survives to spawn a
 * later unexpected turn. On a CLI advertising `interrupt_cancel_queued_v1` one round trip
 * cancels the queue alongside the abort; otherwise the interrupt receipt lists `still_queued`
 * uuids, and each is withdrawn best-effort with `cancel_async_message`. Either way, every send
 * the CLI confirms it withdrew settles as cancelled. Older CLIs resolve no receipt, so there is
 * nothing to sweep.
 */
export async function cancelClaudeTurn(
  session: ClaudeSession,
  timeoutMs: number | undefined,
  isCurrent: ClaudeTurnCancellationGuard = () => true,
  onDispatchSettledLate?: ClaudeLateDispatchSettlement,
  stopped?: { turnId: string; cause: StructuredAgentSessionStopCause }
): Promise<{ cancelled: boolean }> {
  // The SDK interrupt is session-scoped. Re-check the caller's turn/fence
  // immediately before issuing it so a delayed request cannot stop a later turn.
  if (!isCurrent()) {
    return { cancelled: false }
  }
  const cancelQueued = supportsClaudeQueuedInterruptCancellation(session)
  // Recorded before the interrupt goes out, so the result it provokes finds it.
  if (stopped) {
    session.translator?.recordTurnStop(stopped.turnId, stopped.cause)
  }
  try {
    const receipt = await session.connection.interrupt({
      ...(cancelQueued ? { cancelQueued: true } : {}),
      timeoutMs
    })
    if (cancelQueued) {
      settleCancelledClaudeDispatchWaiters(session, receipt?.cancelled ?? [], onDispatchSettledLate)
    } else {
      const withdrawn: string[] = []
      for (const uuid of receipt?.still_queued ?? []) {
        if (await session.connection.cancelAsyncMessage(uuid, { timeoutMs }).catch(() => false)) {
          withdrawn.push(uuid)
        }
      }
      settleCancelledClaudeDispatchWaiters(session, withdrawn, onDispatchSettledLate)
    }
    return { cancelled: true }
  } catch (error) {
    if (error instanceof ClaudeControlRequestError) {
      // The CLI refused, so the turn runs on and its own end means what it says. Any other error
      // leaves the interrupt's effect unknown, and the stop the user asked for stands.
      if (stopped) {
        session.translator?.withdrawTurnStop(stopped.turnId)
      }
      return { cancelled: false }
    }
    throw error
  }
}

/** Stops each task the host named. An acknowledged stop ends the task's record: the CLI answers
 *  success for a task it no longer knows without sending that task any frame. */
export async function stopClaudeBackgroundTasks(
  session: ClaudeSession,
  timeoutMs: number | undefined,
  isCurrent: ClaudeTurnCancellationGuard,
  taskIds: readonly string[]
): Promise<{ cancelled: boolean }> {
  let cancelled = false
  // A failed request for one task still leaves the others to stop; it is reported after them. A
  // timeout ends the loop: a CLI that is not answering would make each id wait out its own
  // deadline while the session's other actions queue behind this one.
  let failure: { error: unknown } | undefined
  for (const taskId of taskIds) {
    if (!isCurrent()) {
      break
    }
    try {
      await session.connection.stopTask(taskId, { timeoutMs })
      session.childWork.stopAcknowledged(taskId)
      cancelled = true
    } catch (error) {
      if (error instanceof ClaudeControlRequestTimeoutError) {
        throw error
      }
      if (!(error instanceof ClaudeControlRequestError)) {
        failure ??= { error }
      }
    }
  }
  if (failure) {
    throw failure.error
  }
  return { cancelled }
}

export async function answerClaudePrompt(
  session: ClaudeSession,
  claim: ClaudePromptClaim,
  reply: PermissionResult
): Promise<void> {
  if (!session.prompts.ownsClaim(claim)) {
    throw new Error(`claude is no longer waiting on ${claim.itemId}`)
  }
  session.prompts.forget(claim.found.prompt)
  claim.found.prompt.settle(reply)
  session.translator?.journalPrompts.resolve(claim.found.prompt.promptKey)
}
