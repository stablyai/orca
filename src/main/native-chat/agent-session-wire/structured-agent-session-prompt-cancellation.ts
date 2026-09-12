import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalResolution
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import {
  isAgentSessionPromptCancelItemIdListWithinBounds,
  isAgentSessionPromptCancelTargetsWithinBounds
} from '../../../shared/agent-session-operation-ledger'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

type PromptTarget = { itemId: string; expectedRevision: number }
type PromptCancellationRefusal = Extract<TurnOutcome<never>, { ok: false }>

function invalid(message: string): PromptCancellationRefusal {
  return { ok: false, refusal: { code: 'agent_session_operation_invalid', message } }
}

export async function preparePromptCancellation(
  ctx: AgentSessionTurnContext,
  target: PromptTarget
): Promise<
  | PromptCancellationRefusal
  | {
      ok: true
      threadId?: string
      turnId: string
      prompts: PromptTarget[]
    }
> {
  const displayed = await ctx.journal.readItem(target.itemId)
  const displayedRefusal = promptCancellationRefusal(target, displayed)
  if (displayedRefusal) {
    return displayedRefusal
  }
  const cancellation = ctx.adapter.promptCancellation?.({
    sessionId: ctx.sessionId,
    itemId: target.itemId,
    fence: ctx.fence
  })
  if (
    !cancellation ||
    !cancellation.itemIds.includes(target.itemId) ||
    !isAgentSessionPromptCancelItemIdListWithinBounds(cancellation.itemIds)
  ) {
    return invalid(`Item ${target.itemId} is not pending on a cancellable turn.`)
  }
  const items = await ctx.journal.readItems(cancellation.itemIds)
  if (!items) {
    return invalid(`The prompt group for ${target.itemId} is incomplete.`)
  }
  const prompts: PromptTarget[] = []
  for (const item of items) {
    if (
      !parseAgentJournalItemKey(item.itemId) ||
      (item.body.kind !== 'approval' && item.body.kind !== 'question')
    ) {
      return invalid(`Item ${item.itemId} is not a pending prompt.`)
    }
    if (item.body.resolution.state === 'pending') {
      prompts.push({ itemId: item.itemId, expectedRevision: item.revision })
    }
  }
  const currentDisplayed = prompts.find((prompt) => prompt.itemId === target.itemId)
  if (!currentDisplayed || currentDisplayed.expectedRevision !== target.expectedRevision) {
    return (
      promptCancellationRefusal(
        target,
        items.find((item) => item.itemId === target.itemId) ?? null
      ) ?? invalid(`Item ${target.itemId} is not a pending prompt.`)
    )
  }
  if (!isAgentSessionPromptCancelTargetsWithinBounds(prompts)) {
    return invalid(`The prompt group for ${target.itemId} is too large to cancel durably.`)
  }
  return {
    ok: true,
    ...(cancellation.threadId ? { threadId: cancellation.threadId } : {}),
    turnId: cancellation.turnId,
    prompts
  }
}

function promptCancellationRefusal(
  target: PromptTarget,
  item: AgentJournalRenderItem | null
): PromptCancellationRefusal | null {
  if (!item || (item.body.kind !== 'approval' && item.body.kind !== 'question')) {
    return invalid(`Item ${target.itemId} is not a pending prompt.`)
  }
  if (!parseAgentJournalItemKey(target.itemId)) {
    return invalid(`Item id ${target.itemId} is not a well-formed item key.`)
  }
  if (item.revision !== target.expectedRevision) {
    return refusal(
      'agent_session_item_revision_stale',
      `Item ${target.itemId} has moved on.`,
      item.revision,
      item.body.resolution
    )
  }
  if (item.body.resolution.state !== 'pending') {
    return refusal(
      'agent_session_already_resolved',
      `Item ${target.itemId} was already ${item.body.resolution.state}.`,
      item.revision,
      item.body.resolution
    )
  }
  return null
}

function refusal(
  code: AgentSessionWireRefusal['code'],
  message: string,
  currentRevision: number,
  resolution: AgentJournalResolution
): PromptCancellationRefusal {
  return {
    ok: false,
    refusal: { code, message, currentRevision, resolution }
  }
}
