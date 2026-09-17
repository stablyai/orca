import { applyClaudePromptAnswer, type ClaudePromptClaim } from './claude-structured-prompt-replies'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import {
  settleCancelledClaudeDispatchWaiters,
  type ClaudeLateDispatchSettlement
} from './claude-structured-dispatch'
import type { ClaudeSession } from './claude-structured-session-state'
import {
  claudePermissionModeRestoreIntent,
  restoreClaudePermissionModeAfterApprovedPrompt
} from './claude-structured-permission-mode'

const INTERRUPT_CANCEL_QUEUED_CAPABILITY = 'interrupt_cancel_queued_v1'

export function supportsClaudeQueuedInterruptCancellation(session: ClaudeSession): boolean {
  return session.capabilities.includes(INTERRUPT_CANCEL_QUEUED_CAPABILITY)
}

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
  isCurrent: ClaudeTurnCancellationGuard = () => true,
  onDispatchSettledLate?: ClaudeLateDispatchSettlement
): Promise<{ cancelled: boolean }> {
  // The SDK interrupt is session-scoped. Re-check the caller's turn/fence
  // immediately before issuing it so a delayed request cannot stop a later turn.
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
  isCurrent: ClaudeTurnCancellationGuard = () => true,
  taskId?: string
): Promise<{ cancelled: boolean }> {
  const stoppableTaskIds = session.backgroundTasks.stoppableTaskIds
  const taskIds =
    taskId === undefined ? stoppableTaskIds : stoppableTaskIds.includes(taskId) ? [taskId] : []
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
  claim: ClaudePromptClaim,
  optionId: string,
  commit: (settlement?: { options: Readonly<Record<string, string>> }) => Promise<void>,
  settleOptions?: (options: Readonly<Record<string, string>>) => Promise<void>,
  timeoutMs?: number
): Promise<void> {
  if (!session.prompts.ownsClaim(claim)) {
    throw new Error(`claude is no longer waiting on ${claim.itemId}`)
  }
  const response = applyClaudePromptAnswer(claim.found, optionId)
  const restoreIntent =
    claim.found.prompt.toolName === 'ExitPlanMode' && response?.behavior === 'allow'
      ? claudePermissionModeRestoreIntent(session)
      : null
  await commit(restoreIntent ? { options: restoreIntent.options } : undefined)
  if (response === null) {
    session.prompts.releaseClaim(claim)
    return
  }
  session.prompts.forget(claim.found.prompt)
  const optionSettlement = restoreIntent
    ? restoreClaudePermissionModeAfterApprovedPrompt(
        session,
        restoreIntent,
        settleOptions,
        timeoutMs
      )
    : null
  claim.found.prompt.settle(response)
  session.translator?.journalPrompts.resolve(claim.found.prompt.promptKey)
  await optionSettlement
}
