import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'

type ItemReader = (itemId: string) => AgentJournalRenderItem | null

/** Only replay produces this reciprocal generated-user/turn relation; live user echoes are ignored. */
export function isHistoricalProviderTimelineItem(
  item: AgentJournalRenderItem,
  read: ItemReader
): boolean {
  const turnItem = readAgentJournalTurn(item.body)
    ? item
    : item.turnScope?.kind === 'turn'
      ? read(item.turnScope.turnItemId)
      : null
  const turn = readAgentJournalTurn(turnItem?.body)
  const identity = turnItem && parseAgentJournalItemKey(turnItem.itemId)
  if (
    !turnItem ||
    !turn?.userItemId ||
    turn.userItemId === turnItem.itemId ||
    identity?.provider !== 'legacy' ||
    !['grok', 'opencode', 'opencode2'].includes(identity.agent) ||
    identity.recordId !== `turn-lifecycle:${turn.turnId}`
  ) {
    return false
  }
  const namespace = /^p:([^:]+):[^:]+$/.exec(turn.turnId)?.[1]
  const opener = read(turn.userItemId)
  const source = opener && parseAgentJournalItemKey(opener.itemId)
  return (
    namespace !== undefined &&
    opener?.itemId === turn.userItemId &&
    opener.body.kind === 'message' &&
    opener.body.role === 'user' &&
    opener.turnScope?.kind === 'turn' &&
    opener.turnScope.turnItemId === turnItem.itemId &&
    source?.provider === 'legacy' &&
    source.agent === identity.agent &&
    source.sessionId === identity.sessionId &&
    source.recordId.startsWith(`item:p:${namespace}:${namespace}/user%3A`) &&
    source.recordId.length > `item:p:${namespace}:${namespace}/user%3A`.length
  )
}

export function providerTimelineExecutionItems(
  items: readonly AgentJournalRenderItem[]
): AgentJournalRenderItem[] {
  const byId = new Map(items.map((item) => [item.itemId, item]))
  return items.filter(
    (item) => !isHistoricalProviderTimelineItem(item, (key) => byId.get(key) ?? null)
  )
}
