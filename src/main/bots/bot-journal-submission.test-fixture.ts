// A journal submission as the host records one, with the fields a bot-attribution test names.
import type { AgentJournalSubmission } from '../../shared/agent-session/journal/agent-session-journal-types'

/** The owner's send from Orca, as the journal reads a person's send. */
export const PERSON_SEND = {
  origin: 'client',
  source: { kind: 'user' }
} satisfies Partial<AgentJournalSubmission>
/** Orca's own continue after a restart or a usage limit. */
export const ORCA_SEND = { origin: 'host' } satisfies Partial<AgentJournalSubmission>

export function journalSubmission(
  fields: Pick<AgentJournalSubmission, 'clientMessageId'> & Partial<AgentJournalSubmission>
): AgentJournalSubmission {
  return {
    fence: 1,
    payloadFingerprint: 'f'.repeat(64),
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: 1,
    ...fields
  }
}
