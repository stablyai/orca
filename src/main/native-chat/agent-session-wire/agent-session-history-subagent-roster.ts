// The roster entries a history page needs but does not carry.
//
// A page serves a contiguous run of the journal, and its cursor is its first item, so it
// cannot pull an older roster row in without skipping the rows between. A subagent whose
// rows are on the page but whose spawn is older than it would then reach the client with
// no name. The page names it beside its items instead; items and cursor are unchanged.

import {
  agentJournalItemSubagentId,
  isRootAgentJournalItem
} from '../../../shared/agent-session-journal-producer'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubagentRosterEntry } from '../../../shared/agent-session-wire'
import {
  isSubagentGroupBlock,
  type NativeChatSubagentEntry
} from '../../../shared/native-chat-types'

/** Bounds the field well inside the page's envelope reserve. */
const MAX_ENTRIES = 64
const MAX_BYTES = 16 * 1024

function rosterEntries(item: AgentJournalRenderItem): readonly NativeChatSubagentEntry[] {
  if (!isRootAgentJournalItem(item) || item.body.kind !== 'message') {
    return []
  }
  return item.body.blocks.flatMap((block) => (isSubagentGroupBlock(block) ? block.agents : []))
}

/** `journal` in journal order; `page` a run of it. Undefined when the page names every
 *  subagent it holds. */
export function offPageSubagentRoster(
  journal: readonly AgentJournalRenderItem[],
  page: readonly AgentJournalRenderItem[]
): AgentSessionSubagentRosterEntry[] | undefined {
  const unnamed = new Set<string>()
  for (const item of page) {
    const agentId = agentJournalItemSubagentId(item)
    if (agentId !== null) {
      unnamed.add(agentId)
    }
  }
  for (const item of page) {
    for (const entry of rosterEntries(item)) {
      unnamed.delete(entry.id)
    }
  }
  if (unnamed.size === 0) {
    return undefined
  }
  const named: AgentSessionSubagentRosterEntry[] = []
  let bytes = 0
  for (const item of journal) {
    for (const entry of rosterEntries(item)) {
      if (!unnamed.delete(entry.id) || named.length >= MAX_ENTRIES) {
        continue
      }
      const candidate: AgentSessionSubagentRosterEntry = {
        itemId: item.itemId,
        sequence: item.sequence,
        ...(item.sequenceIndex === undefined ? {} : { sequenceIndex: item.sequenceIndex }),
        revision: item.revision,
        entry
      }
      const size = Buffer.byteLength(JSON.stringify(candidate), 'utf8')
      if (bytes + size <= MAX_BYTES) {
        named.push(candidate)
        bytes += size
      }
    }
    if (unnamed.size === 0 || named.length >= MAX_ENTRIES) {
      break
    }
  }
  return named.length > 0 ? named : undefined
}
