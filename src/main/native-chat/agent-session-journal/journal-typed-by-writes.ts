import type { AgentJournalTypedBy } from '../../../shared/agent-session/journal/agent-journal-typed-by'

/** 1.4.263 opens a chat holding a saved `typedBy` read-only, so it stays unsaved until every build a
 *  user can downgrade to declares it; sends keep it in memory, so the Slack mirror still names the typist. */
export const JOURNAL_TYPED_BY_WRITES = false

/** `value` as the journal saves it: without its typist stamp while saving one would strand older builds. */
export function journalSavedTypedBy<T extends { typedBy?: AgentJournalTypedBy }>(value: T): T {
  if (JOURNAL_TYPED_BY_WRITES || value.typedBy === undefined) {
    return value
  }
  const { typedBy: _unsaved, ...saved } = value
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: typedBy is optional on T, so T without it is still a T.
  return saved as T
}
