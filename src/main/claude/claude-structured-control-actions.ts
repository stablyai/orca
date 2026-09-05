import { applyClaudePromptAnswer } from './claude-structured-prompt-replies'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import type { ClaudeSession } from './claude-structured-session-state'

const INTERRUPT_CANCEL_QUEUED_CAPABILITY = 'interrupt_cancel_queued_v1'

export type ClaudeTurnCancellationGuard = () => boolean

/**
 * Interrupt the running turn, then make sure no queued async user message survives to spawn a
 * later unexpected turn. On a CLI advertising `interrupt_cancel_queued_v1` one round trip
 * cancels the queue alongside the abort; otherwise the interrupt receipt lists `still_queued`
 * uuids, and each is withdrawn best-effort with `cancel_async_message`. Older CLIs resolve no
 * receipt, so there is nothing to sweep.
 */
export async function cancelClaudeTurn(
  session: ClaudeSession,
  timeoutMs: number | undefined,
  isCurrent: ClaudeTurnCancellationGuard = () => true
): Promise<{ cancelled: boolean }> {
  // The SDK interrupt is session-scoped. Re-check the caller's turn/fence
  // immediately before issuing it so a delayed request cannot stop a later turn.
  if (!isCurrent()) {
    return { cancelled: false }
  }
  const cancelQueued = session.capabilities.includes(INTERRUPT_CANCEL_QUEUED_CAPABILITY)
  try {
    const receipt = await session.connection.interrupt({
      ...(cancelQueued ? { cancelQueued: true } : {}),
      timeoutMs
    })
    if (!cancelQueued) {
      for (const uuid of receipt?.still_queued ?? []) {
        await session.connection.cancelAsyncMessage(uuid, { timeoutMs }).catch(() => {})
      }
    }
    return { cancelled: true }
  } catch (error) {
    if (error instanceof ClaudeControlRequestError) {
      return { cancelled: false }
    }
    throw error
  }
}

export async function stopClaudeBackgroundTasks(
  session: ClaudeSession,
  timeoutMs: number | undefined,
  isCurrent: ClaudeTurnCancellationGuard = () => true
): Promise<{ cancelled: boolean }> {
  const taskIds = session.backgroundTasks.stoppableTaskIds
  let cancelled = false
  for (const taskId of taskIds) {
    if (!isCurrent()) {
      break
    }
    try {
      await session.connection.stopTask(taskId, { timeoutMs })
      cancelled = true
    } catch (error) {
      if (!(error instanceof ClaudeControlRequestError)) {
        throw error
      }
    }
  }
  return { cancelled }
}

export async function answerClaudePrompt(
  session: ClaudeSession,
  input: { itemId: string; kind: 'approval' | 'question'; optionId: string }
): Promise<void> {
  const found = session.prompts.find(input.itemId)
  if (!found || found.prompt.kind !== input.kind) {
    throw new Error(`claude is no longer waiting on ${input.itemId}`)
  }
  const response = applyClaudePromptAnswer(found, input.optionId)
  if (response === null) {
    return
  }
  session.prompts.forget(found.prompt)
  found.prompt.settle(response)
}
