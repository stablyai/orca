// How a member's ended turn is saved on its room post, so the room draws it without its chat rows.
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { BotGroupTurn } from '../../shared/bots/bot-group'
import { rootAssistantProse } from '../../shared/agent-session/requests/structured-agent-session-latest-request'
import { botGroupPageReply } from '../../shared/bots/bot-group-reply-preview'

/** The ended turn among `items`, worded as its header words it: a Stop or a replacement stopped it,
 *  a provider fault failed it; null while it runs or when its turn row is not among them. */
export function botGroupTurnEnd(
  items: readonly AgentJournalRenderItem[]
): Pick<BotGroupTurn, 'end' | 'workedMs' | 'endedAt' | 'turnItemId' | 'hadWork'> | null {
  const row = items.find((item) => item.body.kind === 'turn')
  if (row?.body.kind !== 'turn' || row.body.state === 'running') {
    return null
  }
  const { outcome, durationMs, completedAt, startedAt } = row.body
  const workedMs =
    durationMs ??
    (completedAt !== undefined && startedAt !== undefined ? completedAt - startedAt : undefined)
  return {
    turnItemId: row.itemId,
    endedAt: completedAt,
    hadWork: items.some(
      ({ body }) =>
        body.kind === 'tool-call' ||
        body.kind === 'diff' ||
        body.kind === 'agent-start' ||
        body.kind === 'agent-handoff' ||
        body.kind === 'bot-item-note' ||
        body.kind === 'status' ||
        (body.kind === 'message' &&
          body.role === 'assistant' &&
          body.blocks.some((block) => block.type !== 'text' || block.text.trim()))
    )
      ? true
      : undefined,
    end:
      outcome === 'cancellation' || outcome === 'superseded'
        ? 'stopped'
        : outcome === 'failure'
          ? 'failed'
          : 'finished',
    ...(workedMs === undefined ? {} : { workedMs: Math.max(0, workedMs) })
  }
}

export function settledGroupRoomReply(
  items: readonly AgentJournalRenderItem[]
): string | undefined {
  const text = items
    .map(rootAssistantProse)
    .filter((prose) => prose.trim())
    .join('\n\n')
  return text ? botGroupPageReply(text) : undefined
}
