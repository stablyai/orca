import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { ClaudeTranscriptItemReader } from './claude-transcript-item-reader'

/** The saved item a transcript row's identities name, if any; two different items is ambiguous. */
export function matchSavedHistoryIdentity(
  identities: AgentJournalItemIdentity[],
  saved: ClaudeTranscriptItemReader['saved']
) {
  const matches = identities.flatMap((identity) => saved(agentJournalItemKey(identity)) ?? [])
  if (new Set(matches.map((item) => item.itemId)).size > 1) {
    throw new Error('ambiguous-history-identity')
  }
  const item = matches[0]
  const identity = item ? parseAgentJournalItemKey(item.itemId) : identities[0]
  if (!identity) {
    throw new Error('unknown-history-identity')
  }
  return { identity, item }
}
