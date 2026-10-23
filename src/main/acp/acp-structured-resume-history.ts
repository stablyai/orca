// What a resume of a provider session proves about the chat's journal: whether the agent never
// exchanged a turn on it, and which of the conversations it lost the journal does not hold. Both
// read the chat's journal without opening it, so a launch can ask before it decides to reattach.

import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentSessionProviderHandleChain } from '../../shared/agent-session-provider-handle'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type { JournalLoad } from '../native-chat/agent-session-journal/journal-open'
import {
  isProviderTimelineTurnInNamespace,
  providerTimelineKeyPart,
  spelledProviderTimelineItemKey
} from '../native-chat/agent-session-timeline/provider-timeline-identity'
import { acpSessionNotRestoredItem } from './acp-session-reopen-failure'

type ReadJournal = (sessionId: string) => JournalLoad | null

/** Proof the chat holds no turn of provider session `nativeId`; a journal that does not read whole,
 *  or does not read at all, proves nothing. */
export function nothingExchangedOn(
  readJournal: ReadJournal,
  sessionId: string,
  nativeId: string
): boolean {
  let load: JournalLoad | null
  try {
    load = readJournal(sessionId)
  } catch {
    return false
  }
  if (!load) {
    return true
  }
  if (load.damage || load.newer) {
    return false
  }
  for (const item of load.state.items.values()) {
    const turn = readAgentJournalTurn(item.body)
    if (turn && isProviderTimelineTurnInNamespace(turn.turnId, nativeId)) {
      return false
    }
  }
  return true
}

/** Derived on every start, never stored: a row an attach failure dropped is written by the next
 *  start that succeeds. A journal that does not read whole proves nothing, so none is written. */
export function unannouncedLosses(
  readJournal: ReadJournal,
  sessionId: string,
  chain: AgentSessionProviderHandleChain
): string[] {
  const lost = chain.flatMap((link) =>
    link.replaces?.reason === 'restore-failed' ? [link.replaces.key] : []
  )
  if (lost.length === 0) {
    return []
  }
  let load: JournalLoad | null
  try {
    load = readJournal(sessionId)
  } catch {
    return []
  }
  if (!load) {
    return lost
  }
  if (load.damage || load.newer) {
    return []
  }
  const written = new Set<string>()
  for (const itemId of load.state.items.keys()) {
    const identity = parseAgentJournalItemKey(itemId)
    const spelled =
      identity?.provider === 'legacy' ? spelledProviderTimelineItemKey(identity.recordId) : null
    if (spelled !== null) {
      written.add(spelled)
    }
  }
  // Any session's row counts: one an unused replacement wrote stays when the agent supersedes it.
  return lost.filter((key) => !written.has(providerTimelineKeyPart(acpSessionNotRestoredItem(key))))
}
