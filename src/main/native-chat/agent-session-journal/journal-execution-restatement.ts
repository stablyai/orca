import type {
  AgentJournalProducerLinkage,
  AgentJournalItemBody
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { JournalItemEcho } from './journal-item-echo'
import type { JournalExecutionOrigin } from './journal-execution-item'
import type { ExecutionInterruption } from './journal-execution-interruption'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type { JournalReducerState } from './journal-reducer'
import { journalItemProvenance } from './journal-item-provenance'
import { isJournalExecutionAlias } from './journal-execution-item'

/** A retained provider slot also retains the earlier executions hidden behind that slot. */
export function journalExecutionRestatements(
  previous: JournalReducerState | undefined,
  items: readonly JournalReplacementItem[]
): readonly JournalReplacementItem[] {
  if (!previous) {
    return items
  }
  const selected = new Set(items.map((item) => agentJournalItemKey(item.identity)))
  const retained: JournalReplacementItem[] = []
  for (const item of previous.items.values()) {
    const head = previous.aliases.get(item.itemId)
    if (
      !readAgentJournalTurn(item.body) ||
      !head ||
      head === item.itemId ||
      !selected.has(head) ||
      selected.has(item.itemId)
    ) {
      continue
    }
    const identity = parseAgentJournalItemKey(item.itemId)
    if (!identity) {
      continue
    }
    const provenance = journalItemProvenance(previous, item.itemId)
    retained.push({ ...item, identity, ...provenance, ownerFence: provenance.ownerFence ?? 0 })
  }
  return [...retained, ...items].map((item) => {
    const id = agentJournalItemKey(item.identity)
    const origin = previous.items.get(id)?.executionOrigin
    return origin && !item.executionOrigin ? { ...item, executionOrigin: origin } : item
  })
}

/** A removed execution stays removed, even when its provider address names a different survivor. */
export function copyJournalExecutionRemovals(
  previous: JournalReducerState,
  state: JournalReducerState
): void {
  for (const [alias, itemId] of previous.aliases) {
    const revision = previous.tombstones.get(itemId)
    if (isJournalExecutionAlias(alias) && revision !== undefined) {
      state.aliases.set(alias, itemId)
      state.tombstones.set(itemId, revision)
    }
  }
}

export type JournalReplacementItem = AgentJournalProducerLinkage & {
  echoOf?: JournalItemEcho['echoOf']
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  observedAt?: number
  /** Derive absent legacy scopes from timeline position before persisting them. */
  turnScope?: AgentJournalTurnScope
  /** Preserve original execution provenance; history replacement is not new work. */
  ownerFence: number
  executionOwner?: number
  executionInterruption?: ExecutionInterruption
  executionOrigin?: JournalExecutionOrigin
}
