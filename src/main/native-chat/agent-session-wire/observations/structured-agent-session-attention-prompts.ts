import { isAgentSessionContextClear } from '../../../../shared/agent-session/agent-session-context-clear'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { compareAgentJournalItems } from '../../../../shared/agent-session/journal/agent-session-journal-position'
import {
  reusePromptProjection,
  type PromptProjection
} from './structured-agent-session-actionable-prompts'
import type { StructuredAgentSessionCurrentWorkJournal } from './structured-agent-session-work-evidence'
const attentionProjections = new WeakMap<
  StructuredAgentSessionCurrentWorkJournal,
  PromptProjection
>()

/** Saved attention is independent of executable callbacks and never keeps a provider alive. */
export function structuredAgentSessionAttentionPrompts(
  journal: StructuredAgentSessionCurrentWorkJournal,
  liveFence: number | null,
  isCurrentItem: (itemId: string) => boolean
): AgentJournalRenderItem[] {
  const cursor = journal.cursor()
  const personal = journal.inputOrder.latestPersonAcceptedSequence?.() ?? 0
  const attentionKey = `${personal}:${journal.stopMarks?.latest()?.sequence ?? 0}`
  const prior = attentionProjections.get(journal)
  const reused =
    prior?.attentionKey === attentionKey &&
    prior.personalStopEvidence === journal.personalStopEvidence
      ? reusePromptProjection(journal, prior, cursor, liveFence)
      : undefined
  if (reused) {
    return reused
  }
  const dependencies = new Set<string>()
  const candidates: AgentJournalRenderItem[] = []
  let contextFloor = 0
  journal.visitItems((itemId, sequence, body) => {
    if (isAgentSessionContextClear(body)) {
      contextFloor = Math.max(contextFloor, sequence)
    }
    if (
      (body.kind !== 'approval' && body.kind !== 'question') ||
      body.resolution.state !== 'pending'
    ) {
      return
    }
    dependencies.add(itemId)
    const item = journal.item(itemId)
    if (!item || (item.sequence < personal && !isCurrentItem(itemId))) {
      return
    }
    const turnItemId = item.turnScope?.kind === 'turn' ? item.turnScope.turnItemId : undefined
    if (turnItemId) {
      dependencies.add(turnItemId)
    }
    const turnId = turnItemId
      ? readAgentJournalTurn(journal.item(turnItemId)?.body)?.turnId
      : undefined
    if (
      journal.personalStopAfter?.({
        cursor: { epoch: cursor.epoch, sequence: item.sequence },
        at: item.observedAt,
        ...(turnId ? { turnId } : {})
      }) !== 'stopped'
    ) {
      candidates.push(item)
    }
  })
  const items = candidates.filter((item) => item.sequence > contextFloor)
  items.sort(compareAgentJournalItems)
  const stable =
    prior?.items.length === items.length &&
    items.every((item, index) => item === prior.items[index])
      ? prior.items
      : items
  attentionProjections.set(journal, {
    ...cursor,
    fence: liveFence,
    attentionKey,
    personalStopEvidence: journal.personalStopEvidence,
    dependencies,
    items: stable
  })
  return stable
}
