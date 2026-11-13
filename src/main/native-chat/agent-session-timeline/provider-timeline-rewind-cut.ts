import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import {
  isProviderTimelineTurnInNamespace,
  providerTimelineTurnKeyPart
} from './provider-timeline-identity'

export function providerTimelineRewindCut(
  items: readonly AgentJournalRenderItem[],
  itemId: string,
  namespace: string
): { beforeTurnId: string; kept: AgentJournalRenderItem[] } | null {
  const roots = new Map<string, NonNullable<ReturnType<typeof readAgentJournalTurn>>>()
  const openers = new Map<string, string>()
  for (const item of items) {
    const turn = readAgentJournalTurn(item.body)
    if (turn) {
      roots.set(item.itemId, turn)
      if (turn.userItemId) {
        openers.set(turn.userItemId, item.itemId)
      }
    }
  }
  const selected = items.find((item) => item.itemId === itemId)
  const rootId =
    selected?.turnScope?.kind === 'turn' ? selected.turnScope.turnItemId : openers.get(itemId)
  const turn = rootId ? roots.get(rootId) : undefined
  if (
    !turn ||
    turn.userItemId !== itemId ||
    !isProviderTimelineTurnInNamespace(turn.turnId, namespace)
  ) {
    return null
  }
  const part = providerTimelineTurnKeyPart(turn.turnId)
  if (!part || part.includes('#')) {
    return null
  }
  let beforeTurnId: string
  try {
    beforeTurnId = decodeURIComponent(part)
  } catch {
    return null
  }
  if (turn.providerTurnId && turn.providerTurnId !== beforeTurnId) {
    return null
  }
  const member = (item: AgentJournalRenderItem): string | undefined =>
    roots.has(item.itemId)
      ? item.itemId
      : item.turnScope?.kind === 'turn'
        ? item.turnScope.turnItemId
        : openers.get(item.itemId)
  const boundary = items.findIndex((item) => member(item) === rootId)
  const keptRoots = new Set(items.slice(0, boundary).flatMap((item) => member(item) ?? []))
  return {
    beforeTurnId,
    kept: items.filter((item, index) => index < boundary || keptRoots.has(member(item) ?? ''))
  }
}
