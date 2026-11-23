// How a member's ended turn is saved on its room post, so the room draws it without its chat rows.
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { BotGroupTurn } from '../../shared/bots/bot-group'

/** The ended turn among `items`, worded as its header words it: a Stop or a replacement stopped it,
 *  a provider fault failed it; null while it runs or when its turn row is not among them. */
export function botGroupTurnEnd(
  items: readonly AgentJournalRenderItem[]
): Pick<BotGroupTurn, 'end' | 'workedMs'> | null {
  const row = items.find((item) => item.body.kind === 'turn')
  if (row?.body.kind !== 'turn' || row.body.state === 'running') {
    return null
  }
  const { outcome, durationMs, completedAt, startedAt } = row.body
  const workedMs =
    durationMs ??
    (completedAt !== undefined && startedAt !== undefined ? completedAt - startedAt : undefined)
  return {
    end:
      outcome === 'cancellation' || outcome === 'superseded'
        ? 'stopped'
        : outcome === 'failure'
          ? 'failed'
          : 'finished',
    ...(workedMs === undefined ? {} : { workedMs: Math.max(0, workedMs) })
  }
}
