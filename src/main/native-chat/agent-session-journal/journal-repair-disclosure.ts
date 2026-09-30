// What a repair tells the user it did.
//
// The identity is a constant because replay reads it back: an epoch holding
// nothing but its anchor and this row is a repair that has not been
// reconstructed yet, not a timeline.

import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'

/** One stable identity, so a reopen upserts the same row instead of adding one. */
export const JOURNAL_REPAIR_DISCLOSURE_IDENTITY: AgentJournalItemIdentity = {
  provider: 'orca',
  clientMessageId: 'journal-malformed-lines'
}

export const JOURNAL_REPAIR_DISCLOSURE_ITEM_ID = agentJournalItemKey(
  JOURNAL_REPAIR_DISCLOSURE_IDENTITY
)

export type JournalRepairDisclosure = {
  identity: AgentJournalItemIdentity
  body: { kind: 'status'; text: string }
}

/** Disclosed when a repair skipped a row it could not read. */
export function journalRepairDisclosure(input: { malformedRows: number }): JournalRepairDisclosure {
  const lines = `${input.malformedRows} journal line${input.malformedRows === 1 ? '' : 's'}`
  return {
    identity: JOURNAL_REPAIR_DISCLOSURE_IDENTITY,
    body: { kind: 'status', text: `${lines} could not be read` }
  }
}
