// Keep history/cursors contiguous; name off-page subagent spawns separately so visible child rows keep labels.

import {
  agentJournalItemSubagentId,
  isRootAgentJournalItem
} from '../../../shared/agent-session-journal-producer'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubagentRosterEntry } from '../../../shared/agent-session-wire'
import { namedSubagents } from '../../../shared/native-chat/transcript/native-chat-subagent-items'
import type { NativeChatSubagentEntry } from '../../../shared/native-chat-types'

const MAX_ENTRIES = 64
const MAX_BYTES = 16 * 1024

function rosterEntries(item: AgentJournalRenderItem): readonly NativeChatSubagentEntry[] {
  if (!isRootAgentJournalItem(item) || item.body.kind !== 'message') {
    return []
  }
  return item.body.blocks.flatMap(namedSubagents)
}

/** Input journal is ordered; omit the roster when the page already names every visible subagent. */
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
