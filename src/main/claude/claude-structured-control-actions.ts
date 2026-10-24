import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { AgentChildWorkStopAcknowledgement } from '../../shared/agent-child-work-stop-targets'
import type { ClaudePromptClaim } from './claude-structured-prompt-replies'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import { ClaudeControlRequestTimeoutError } from './claude-agent-sdk-control-requests'
import { settleCancelledClaudeDispatchWaiters } from './claude-structured-dispatch'
import type { ClaudeLateDispatchSettlement } from './claude-replay-turn-resolution'
import type { ClaudeSession } from './claude-structured-session-state'

const INTERRUPT_CANCEL_QUEUED_CAPABILITY = 'interrupt_cancel_queued_v1'

export function supportsClaudeQueuedInterruptCancellation(session: ClaudeSession): boolean {
  return session.capabilities.includes(INTERRUPT_CANCEL_QUEUED_CAPABILITY)
}

export type ClaudeTurnCancellationGuard = () => boolean

/** Cancel queued sends atomically when supported; otherwise withdraw UUIDs from the interrupt receipt. */
export async function cancelClaudeTurn(
  session: ClaudeSession,
  timeoutMs: number | undefined,
  isCurrent: ClaudeTurnCancellationGuard = () => true,
  onDispatchSettledLate?: ClaudeLateDispatchSettlement
): Promise<{ cancelled: boolean }> {
  // Interrupt is session-scoped; recheck ownership immediately before sending.
  if (!isCurrent()) {
    return { cancelled: false }
  }
  const cancelQueued = supportsClaudeQueuedInterruptCancellation(session)
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
    // Only an explicit refusal proves the interrupt had no effect.
    if (error instanceof ClaudeControlRequestError) {
      return { cancelled: false }
    }
    throw error
  }
}

/** Acknowledgements are provisional: the CLI also reports success for unknown tasks. */
export async function stopClaudeBackgroundTasks(
  session: ClaudeSession,
  timeoutMs: number | undefined,
  isCurrent: ClaudeTurnCancellationGuard,
  taskIds: readonly string[],
  acknowledge: (acknowledgement: AgentChildWorkStopAcknowledgement) => void = () => {}
): Promise<{ cancelled: boolean }> {
  let cancelled = false
  // Continue after individual failures; a timeout aborts to avoid one deadline per task.
  let failure: { error: unknown } | undefined
  for (const taskId of taskIds) {
    if (!isCurrent()) {
      break
    }
    try {
      await session.connection.stopTask(taskId, { timeoutMs })
      cancelled = true
      acknowledge({ taskId })
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

export async function stopCurrentClaudeBackgroundTasks(input: {
  sessions: ReadonlyMap<string, ClaudeSession>
  session: ClaudeSession
  sessionId: string
  fence: number
  taskIds: readonly string[]
  timeoutMs: number | undefined
  acknowledge?: (acknowledgement: AgentChildWorkStopAcknowledgement) => void
}): Promise<{ cancelled: boolean }> {
  const { sessions, session, sessionId, fence } = input
  const acquisitionGeneration = session.acquisitionGeneration
  const isCurrent = () =>
    sessions.get(sessionId) === session &&
    session.fence === fence &&
    session.acquisitionGeneration === acquisitionGeneration
  return stopClaudeBackgroundTasks(
    session,
    input.timeoutMs,
    isCurrent,
    input.taskIds,
    input.acknowledge
  )
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
