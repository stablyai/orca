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
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { measureAgentSessionText } from '../agent-session-wire/agent-session-text-encoding'
import type { AgentSessionDeltaSource } from '../agent-session-wire/agent-session-delta-coalescer'
import { journalTextField } from './journal-text-rows'
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
  next: AgentJournalRenderItem & { turnScope: AgentJournalTurnScope },
  /** The write's fence, and the provenance it states (`JournalItemRow.ownerFence`), which only
   *  creation reads: a revision keeps the item's. A stated `executionOwner` moves on any write. */
  fences: { fence: number; ownerFence?: number; executionOwner?: number },
  policy?: AgentSessionDeltaSource
): boolean {
  const tombstoned = state.tombstones.get(itemId)
  if (tombstoned !== undefined && revision <= tombstoned) {
    return false
  }
  const existing = state.items.get(itemId)
  if (existing && revision <= existing.revision) {
    return false
  }
  const priorPolicy = state.textPolicy.get(itemId)
  const text = journalTextField(next.body, 0)
  if (text !== null && (policy || priorPolicy)) {
    const inherited =
      priorPolicy && existing && text === journalTextField(existing.body, 0)
        ? priorPolicy
        : undefined
    const nextPolicy = policy ??
      inherited ?? {
        ...priorPolicy,
        ...measureAgentSessionText(text),
        cuts: undefined,
        observedBytes: Math.max(priorPolicy?.observedBytes ?? 0, Buffer.byteLength(text, 'utf8')),
        truncated: priorPolicy?.truncated ?? false
      }
    nextPolicy.revision = revision
    if (nextPolicy.live) {
      nextPolicy.live = {
        ...nextPolicy.live,
        options: {
          ...agentJournalLinkageFields(namesAgentJournalProducer(next) ? next : (existing ?? next)),
          turnScope: existing?.turnScope ?? next.turnScope,
          observedAt: existing?.observedAt ?? next.observedAt
        },
        body: {
          ...next.body,
          ...(next.body.kind === 'message'
            ? {
                blocks: next.body.blocks.map((block) =>
                  block.type === 'text' ? { ...block, text: '' } : block
                )
              }
            : {})
        }
      }
    }
    state.textPolicy.set(itemId, nextPolicy)
  } else if (text === null) {
    state.textPolicy.delete(itemId)
  }
  state.derivedTurnScope.observe(itemId, isRootAgentJournalItem(next), existing?.body, next.body)
  if (fences.executionOwner !== undefined) {
    state.itemExecutionOwners.set(itemId, fences.executionOwner)
  }
  if (!existing) {
    state.items.set(itemId, next)
    state.itemFences.set(itemId, fences.ownerFence ?? fences.fence)
    state.tombstones.delete(itemId)
    return true
  }
  // Pin creation position/time so provider echoes cannot move submitted bubbles below later messages.
  const submitted =
    existing.body.kind === 'message' &&
    existing.body.role === 'user' &&
    parseAgentJournalItemKey(itemId)?.provider === 'orca'
  const { sequenceIndex: _revisedAt, ...revised } = next
  state.items.set(itemId, {
    ...revised,
    // Host bookkeeping without explicit producer must retain subagent linkage.
    ...(namesAgentJournalProducer(next) ? {} : agentJournalLinkageFields(existing)),
    // Provider history may normalize text or omit local attachments from the original send.
    body: submitted ? existing.body : next.body,
    sequence: existing.sequence,
    ...(existing.sequenceIndex !== undefined ? { sequenceIndex: existing.sequenceIndex } : {}),
    observedAt: existing.observedAt,
    turnScope: existing.turnScope ?? next.turnScope
  })
  state.tombstones.delete(itemId)
  return true
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
    const turnId = readAgentJournalTurn(existing.body)?.turnId
    if (turnId !== undefined) {
      state.removedTurnIds.add(turnId)
    }
  }
  state.tombstones.set(itemId, revision)
  state.textPolicy.delete(itemId)
  state.items.delete(itemId)
  state.itemFences.delete(itemId)
  state.itemExecutionOwners.delete(itemId)
}
