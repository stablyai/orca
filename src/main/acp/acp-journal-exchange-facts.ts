import type { AcpStructuredLaunchPartDeps } from './acp-structured-launch-resolution'

// Launch from durable record values for the working directory, pinned account and resume session.

import { parseAgentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentSessionProviderHandleChain } from '../../shared/agent-session/lifecycle/agent-session-provider-handle'

import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/agent-session-turn-record'
import type { JournalLoad } from '../native-chat/agent-session-journal/journal-open'
import {
  isProviderTimelineTurnInNamespace,
  providerTimelineKeyPart,
  spelledProviderTimelineItemKey
} from '../native-chat/agent-session-timeline/provider-timeline-identity'

import { acpSessionNotRestoredItem } from './acp-session-reopen-failure'

/** Missing journals count as empty; read errors or damaged/newer journals cannot prove no exchange. */
export async function nothingExchangedOn(
  readJournal: AcpStructuredLaunchPartDeps['readJournal'],
  sessionId: string,
  nativeId: string
): Promise<boolean> {
  let load: JournalLoad | null
  try {
    load = await readJournal(sessionId)
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

/** Retry missing loss-warning rows on successful starts; unreadable journals suppress new warnings. */
export async function unannouncedLosses(
  readJournal: AcpStructuredLaunchPartDeps['readJournal'],
  sessionId: string,
  chain: AgentSessionProviderHandleChain
): Promise<string[]> {
  const lost = chain.flatMap((link) =>
    link.replaces?.reason === 'restore-failed' ? [link.replaces.key] : []
  )
  if (lost.length === 0) {
    return []
  }
  let load: JournalLoad | null
  try {
    load = await readJournal(sessionId)
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
  // Warnings survive even if the replacement session that wrote them is superseded.
  return lost.filter((key) => !written.has(providerTimelineKeyPart(acpSessionNotRestoredItem(key))))
}
