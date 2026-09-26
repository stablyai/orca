// Folding one item write into the render model: the revision, tombstone and creating-write rules
// the reducer header states. Turn scope is the creating write's too, with one exception, which the
// submission fold owns: a queued message's scope is the turn its handover delivered it into.

import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  agentJournalLinkageFields,
  isRootAgentJournalItem,
  namesAgentJournalProducer
} from '../../../shared/agent-session-journal-producer'
import type { JournalReducerState } from './journal-reducer'

export function statedOrDerivedTurnScope(
  state: JournalReducerState,
  write: { body: AgentJournalItemBody; turnScope?: AgentJournalTurnScope }
): AgentJournalTurnScope {
  return write.turnScope ?? state.derivedTurnScope.scopeFor(write.body)
}

export function upsertJournalItem(
  state: JournalReducerState,
  itemId: string,
  revision: number,
  next: AgentJournalRenderItem
): void {
  const tombstoned = state.tombstones.get(itemId)
  if (tombstoned !== undefined && revision <= tombstoned) {
    return
  }
  const existing = state.items.get(itemId)
  if (existing && revision <= existing.revision) {
    return
  }
  state.derivedTurnScope.observe(itemId, isRootAgentJournalItem(next), existing?.body, next.body)
  if (!existing) {
    state.items.set(itemId, next)
    state.tombstones.delete(itemId)
    return
  }
  // Creation sequence is the ordering key; a revision refreshes content only.
  // `observedAt` is pinned with it: clients sort the timeline by that timestamp,
  // so letting a revision advance it makes the row jump past everything that
  // landed in between — the provider's own echo of a send revises the submission
  // row, which relocated the user's bubble below later rows.
  const submitted =
    existing.body.kind === 'message' &&
    existing.body.role === 'user' &&
    parseAgentJournalItemKey(itemId)?.provider === 'orca'
  state.items.set(itemId, {
    ...next,
    // Settlements, prompt answers and reopen sweeps revise rows any agent wrote
    // without naming one; each would otherwise hand a subagent's row to the session.
    ...(namesAgentJournalProducer(next) ? {} : agentJournalLinkageFields(existing)),
    // Provider history may normalize text or omit local attachments from the original send.
    body: submitted ? existing.body : next.body,
    sequence: existing.sequence,
    observedAt: existing.observedAt,
    turnScope: existing.turnScope ?? next.turnScope
  })
  state.tombstones.delete(itemId)
}

export function removeJournalItem(
  state: JournalReducerState,
  itemId: string,
  revision: number
): void {
  const existing = state.items.get(itemId)
  if (existing && revision <= existing.revision) {
    return
  }
  const tombstoned = state.tombstones.get(itemId)
  if (tombstoned !== undefined && revision <= tombstoned) {
    return
  }
  if (existing) {
    state.derivedTurnScope.observe(
      itemId,
      isRootAgentJournalItem(existing),
      existing.body,
      undefined
    )
  }
  state.tombstones.set(itemId, revision)
  state.items.delete(itemId)
}
