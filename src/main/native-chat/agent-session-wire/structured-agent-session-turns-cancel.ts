import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentJournalStatusItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionCancelResult } from '../../../shared/agent-session-wire'
import { latestJournalDispatchObservation } from '../agent-session-journal/journal-dispatch-observation'
import type { AgentSessionCancelOutcome } from './structured-agent-session-adapter'
import {
  isStructuredAgentSessionCommandTurnId,
  structuredAgentSessionCommandWasStopped,
  structuredAgentSessionStopNoteIdentity
} from './structured-agent-session-command-turn'
import { validatePendingPrompt } from './structured-agent-session-prompt-state'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

export async function performCancel(
  ctx: AgentSessionTurnContext,
  input: {
    clientOperationId: string
    /** Absent: whatever the conversation has in flight; present: only while that turn is current. */
    turnId?: string
    scope?: 'background-tasks'
    taskId?: string
    prompt?: { itemId: string; expectedRevision: number }
    /** Ends the provider child, for a running command the provider did not take the Stop on. */
    stopChild?: () => Promise<void>
  }
): Promise<TurnOutcome<AgentSessionCancelResult>> {
  if (input.prompt) {
    const validated = validatePendingPrompt(ctx, input.prompt)
    if (!validated.ok) {
      return validated
    }
  }
  let cancelled = false
  let note: AgentJournalStatusItem | null = { kind: 'status', text: 'Cancellation requested.' }
  // The turn the Stop names, read before the cancel settles it: the note reports on that turn.
  const turnScope = ctx.journal.liveTurnScope()
  // Only the provider's end or the child's ends a command. A command the provider has not opened a
  // turn for, would not interrupt, or was already asked to stop, ends with its child; that child's
  // dead-generation settlement writes the command's verdict.
  const liveTurnId = ctx.journal.activeTurnId()
  const runningCommand =
    input.stopChild !== undefined &&
    liveTurnId !== null &&
    isStructuredAgentSessionCommandTurnId(liveTurnId) &&
    (input.turnId === undefined || input.turnId === liveTurnId)
  const stoppedBefore =
    runningCommand && structuredAgentSessionCommandWasStopped(ctx.journal, liveTurnId)
  try {
    const dispatchStatus = latestJournalDispatchObservation(ctx.journal, ctx.fence)
    const outcome: AgentSessionCancelOutcome = stoppedBefore
      ? { cancelled: false }
      : input.scope
        ? {
            cancelled:
              (
                await ctx.adapter.stopBackgroundTasks?.({
                  sessionId: ctx.sessionId,
                  fence: ctx.fence,
                  ...(input.taskId ? { taskId: input.taskId } : {})
                })
              )?.cancelled === true
          }
        : await ctx.adapter.cancelTurn({
            sessionId: ctx.sessionId,
            ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
            fence: ctx.fence,
            // The journal is what the client read to name a turn, so it is what judges the request.
            resolveLiveTurnId: () => ctx.journal.activeTurnId(),
            ...(dispatchStatus ? { dispatchStatus } : {}),
            ...(input.prompt ? { prompt: { itemId: input.prompt.itemId } } : {})
          })
    cancelled = outcome.cancelled
    if (!cancelled && input.turnId !== undefined) {
      note = { kind: 'status', text: 'The provider had already finished this turn.' }
    } else if (!cancelled && input.prompt) {
      note = null
    } else if (!cancelled) {
      // Sent only while the chat reads working, so a Stop that ended nothing must say why.
      const detail = outcome.refusal?.detail
      note = {
        kind: 'status',
        ...agentSessionFailureWords(
          agentSessionFailureFact('stopRefused', detail ? { detail } : {}),
          { ...ctx.failureTextContext, surface: 'row' }
        )
      }
    }
  } catch (error) {
    if (input.prompt) {
      throw error
    }
    // The adapter's error is Orca's; the row says only that the stop is unconfirmed.
    note = {
      kind: 'status',
      ...agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), { surface: 'row' })
    }
  }
  if (runningCommand && !cancelled) {
    await input.stopChild?.()
    cancelled = true
    note = { kind: 'status', text: 'Cancellation requested.' }
  }
  if (cancelled && input.prompt) {
    await ctx.flushStreamedEvents()
  }
  const value = { ...(input.turnId !== undefined ? { turnId: input.turnId } : {}), cancelled }
  if (input.scope || note === null) {
    return { ok: true, value }
  }
  // Keyed by the operation id so a replayed cancel upserts one item, not two.
  await ctx.journal.appendItem(
    structuredAgentSessionStopNoteIdentity(input.clientOperationId),
    note,
    { fence: ctx.fence, turnScope }
  )
  return { ok: true, value }
}
