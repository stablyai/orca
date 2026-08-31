// The effects behind send / cancel / respond / setOption.
//
// Admission (lease, fence, idempotency) has already passed by the time anything
// here runs; these functions own only the journal writes and the adapter call,
// in that order. Journal first is deliberate: a crash between the two leaves a
// row the next attach settles as `unknown`, whereas the reverse would lose a
// turn the provider already accepted.

import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalResolution
} from '../../../shared/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { decodeCodexQuestionOptionId } from '../../codex/codex-structured-prompt-replies'
import type {
  AgentSessionCancelResult,
  AgentSessionOptionResult,
  AgentSessionPromptResult,
  AgentSessionSendResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { isAgentSessionOptionRejectedError } from './structured-agent-session-option-error'

export type AgentSessionTurnContext = {
  sessionId: string
  journal: AgentSessionJournal
  fence: number
  adapter: StructuredAgentSessionAdapter
  persistedOptions?: Readonly<Record<string, string>>
  persistOptions: (options: Readonly<Record<string, string>>) => Promise<void>
  /** Opaque client identity recorded as the resolver of a prompt. */
  resolvedBy: string
  publish: () => void
  now: () => number
}

export type TurnOutcome<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; refusal: AgentSessionWireRefusal }

function invalid(message: string): { ok: false; refusal: AgentSessionWireRefusal } {
  return { ok: false, refusal: { code: 'agent_session_operation_invalid', message } }
}

/** A thrown adapter error is indistinguishable from a lost reply, so it settles
 *  as `unknown` rather than as a rejection. */
async function dispatchSafely(
  ctx: AgentSessionTurnContext,
  clientMessageId: string,
  body: AgentJournalMessageItem
): Promise<AgentSessionDispatchOutcome> {
  try {
    return await ctx.adapter.dispatch({
      sessionId: ctx.sessionId,
      clientMessageId,
      body,
      fence: ctx.fence
    })
  } catch (error) {
    return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }
  }
}

async function appendStatus(
  ctx: AgentSessionTurnContext,
  clientMessageId: string,
  text: string
): Promise<void> {
  await ctx.journal.appendItem(
    { provider: 'orca', clientMessageId },
    { kind: 'status', text },
    { fence: ctx.fence }
  )
  ctx.publish()
}

export async function performSend(
  ctx: AgentSessionTurnContext,
  input: {
    clientMessageId: string
    payloadFingerprint: string
    body: AgentJournalMessageItem
    retryUnknown?: true
  }
): Promise<TurnOutcome<AgentSessionSendResult>> {
  const existing = ctx.journal
    .submissions()
    .find((entry) => entry.clientMessageId === input.clientMessageId)
  if (existing && existing.payloadFingerprint !== input.payloadFingerprint) {
    return invalid(`Message id ${input.clientMessageId} was already used for another send.`)
  }
  if (existing && !(input.retryUnknown && existing.dispatchState === 'unknown')) {
    return {
      ok: true,
      value: { clientMessageId: input.clientMessageId, submission: existing }
    }
  }
  if (!(input.retryUnknown && existing?.dispatchState === 'unknown')) {
    await ctx.journal.appendSubmission({ ...input, fence: ctx.fence })
    ctx.publish()
  }

  const outcome = await dispatchSafely(ctx, input.clientMessageId, input.body)
  await ctx.journal.resolveDispatch(
    outcome.state === 'accepted'
      ? {
          clientMessageId: input.clientMessageId,
          state: 'accepted',
          providerIdentity: outcome.providerIdentity,
          fence: ctx.fence
        }
      : {
          clientMessageId: input.clientMessageId,
          state: outcome.state,
          reason: outcome.reason,
          fence: ctx.fence
        }
  )
  ctx.publish()

  const submission = ctx.journal
    .submissions()
    .find((entry) => entry.clientMessageId === input.clientMessageId)
  if (!submission) {
    throw new Error('agent_session_submission_lost')
  }
  return { ok: true, value: { clientMessageId: input.clientMessageId, submission } }
}

export async function performCancel(
  ctx: AgentSessionTurnContext,
  input: { clientOperationId: string; turnId: string }
): Promise<TurnOutcome<AgentSessionCancelResult>> {
  let cancelled = false
  let note = 'Turn cancelled.'
  try {
    cancelled = (
      await ctx.adapter.cancelTurn({
        sessionId: ctx.sessionId,
        turnId: input.turnId,
        fence: ctx.fence
      })
    ).cancelled
    if (!cancelled) {
      note = 'The provider had already finished this turn.'
    }
  } catch (error) {
    note = `Cancellation was not confirmed: ${
      error instanceof Error ? error.message : String(error)
    }`
  }
  // Keyed by the operation id so a replayed cancel upserts one item, not two.
  await appendStatus(ctx, input.clientOperationId, note)
  return { ok: true, value: { turnId: input.turnId, cancelled } }
}

function promptBodyOf(body: AgentJournalItemBody): {
  options: readonly { id: string }[]
  freeTextQuestionId?: string
  resolution: AgentJournalResolution
} | null {
  return body.kind === 'approval' || body.kind === 'question' ? body : null
}

/**
 * Durable compare-and-set on (itemId, revision) plus the pending state. The
 * journal write commits before the provider callback fires, so two clients
 * answering one prompt produce exactly one callback and the loser is told which
 * answer won.
 */
export async function performPrompt(
  ctx: AgentSessionTurnContext,
  input: {
    itemId: string
    expectedRevision: number
    optionId: string
    kind: 'approval' | 'question'
  }
): Promise<TurnOutcome<AgentSessionPromptResult>> {
  const item = ctx.journal.snapshot().items.find((entry) => entry.itemId === input.itemId)
  if (!item) {
    return invalid(`No item ${input.itemId} in session ${ctx.sessionId}.`)
  }
  const prompt = promptBodyOf(item.body)
  if (!prompt || item.body.kind !== input.kind) {
    return invalid(`Item ${input.itemId} is not a pending ${input.kind}.`)
  }
  if (item.revision !== input.expectedRevision) {
    return {
      ok: false,
      refusal: {
        code: 'agent_session_item_revision_stale',
        message: `Item ${input.itemId} has moved on.`,
        currentRevision: item.revision,
        resolution: prompt.resolution
      }
    }
  }
  if (prompt.resolution.state !== 'pending') {
    return {
      ok: false,
      refusal: {
        code: 'agent_session_already_resolved',
        message: `Item ${input.itemId} was already ${prompt.resolution.state}.`,
        currentRevision: item.revision,
        resolution: prompt.resolution
      }
    }
  }
  const freeText = decodeCodexQuestionOptionId(input.optionId)
  const acceptsFreeText =
    item.body.kind === 'question' &&
    prompt.freeTextQuestionId !== undefined &&
    freeText?.questionId === prompt.freeTextQuestionId &&
    freeText.answer.trim().length > 0
  if (!acceptsFreeText && !prompt.options.some((option) => option.id === input.optionId)) {
    return invalid(`Option ${input.optionId} is not offered by item ${input.itemId}.`)
  }
  const identity = parseAgentJournalItemKey(input.itemId)
  if (!identity) {
    return invalid(`Item id ${input.itemId} is not a well-formed item key.`)
  }

  const resolution: AgentJournalResolution = {
    state: 'resolved',
    selectedOptionId: input.optionId,
    resolvedBy: ctx.resolvedBy,
    resolvedAt: ctx.now()
  }
  const appended = await ctx.journal.appendItem(
    identity,
    { ...item.body, resolution },
    {
      fence: ctx.fence
    }
  )
  ctx.publish()

  try {
    await ctx.adapter.answerPrompt({
      sessionId: ctx.sessionId,
      itemId: input.itemId,
      kind: input.kind,
      optionId: input.optionId,
      fence: ctx.fence
    })
  } catch (error) {
    // The answer is committed and will not be offered again; say so rather than
    // reopening the prompt and risking a second callback.
    await appendStatus(
      ctx,
      `${input.itemId}#delivery`,
      `Your answer was recorded but the agent did not confirm it: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  return {
    ok: true,
    value: { itemId: appended.itemId, revision: appended.revision, resolution }
  }
}

/** Options live on the provider, not in the journal, so this writes nothing. */
export async function performSetOption(
  ctx: AgentSessionTurnContext,
  input: { key: string; value: string }
): Promise<TurnOutcome<AgentSessionOptionResult>> {
  let applied: void | Readonly<Record<string, string>>
  try {
    applied = await ctx.adapter.setOption({
      sessionId: ctx.sessionId,
      ...input,
      fence: ctx.fence
    })
  } catch (error) {
    if (isAgentSessionOptionRejectedError(error)) {
      return invalid(error.message)
    }
    throw error
  }
  await ctx.persistOptions(applied ?? { [input.key]: input.value })
  return { ok: true, value: { ...input, ...(applied ? { options: { ...applied } } : {}) } }
}
