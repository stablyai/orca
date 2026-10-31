import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'

/**
 * An interrupted turn record with no completion time was settled by Orca, not read from the
 * provider: the turn was open when no writer could still add to it. It stays revisitable, so a
 * real boundary the provider wrote later (and any rows of that turn) replace it on the next import.
 */
export function isSyntheticInterruptedTurn(
  body: AgentJournalItemBody | undefined
): body is Extract<AgentJournalItemBody, { kind: 'turn' }> {
  return body?.kind === 'turn' && body.state === 'interrupted' && body.completedAt === undefined
}

/** A recorded boundary may replace a running or Orca-settled record of the same turn. */
export function turnRecordReplaceable(
  current: AgentJournalItemBody,
  next: AgentJournalItemBody
): boolean {
  return (
    next.kind === 'turn' &&
    current.kind === 'turn' &&
    (current.state === 'running' ||
      (isSyntheticInterruptedTurn(current) && !isSyntheticInterruptedTurn(next)))
  )
}
