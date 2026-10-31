import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'

type TurnBody = Extract<AgentJournalItemBody, { kind: 'turn' }>

/**
 * An interrupted turn record with no completion time was settled by Orca, not read from the
 * provider: the turn was open when no writer could still add to it. It stays revisitable, so a
 * real boundary the provider wrote later (and any rows of that turn) replace it on the next import.
 */
export function isSyntheticInterruptedTurn(
  body: AgentJournalItemBody | undefined
): body is TurnBody {
  return body?.kind === 'turn' && body.state === 'interrupted' && body.completedAt === undefined
}

/**
 * An interrupted record with no verdict: Orca settled it, or an earlier import dropped the
 * provider's reason. Evidence read later (the provider's stop record, a proven Stop) may add one.
 */
export function isUnexplainedInterruptedTurn(
  body: AgentJournalItemBody | undefined
): body is TurnBody {
  return body?.kind === 'turn' && body.state === 'interrupted' && body.outcome === undefined
}

/**
 * A recorded boundary may replace a running or Orca-settled record of the same turn, and an
 * unexplained interruption takes the verdict its evidence carries; any other recorded end stays.
 */
export function turnRecordReplaceable(
  current: AgentJournalItemBody,
  next: AgentJournalItemBody
): boolean {
  return (
    next.kind === 'turn' &&
    current.kind === 'turn' &&
    (current.state === 'running' ||
      (isSyntheticInterruptedTurn(current) && !isSyntheticInterruptedTurn(next)) ||
      (isUnexplainedInterruptedTurn(current) &&
        next.state === 'interrupted' &&
        next.outcome !== undefined))
  )
}

/** A record an earlier import saved without its prompt takes the one a later read names, unchanged otherwise. */
export function withNamedPrompt(
  current: AgentJournalItemBody,
  next: AgentJournalItemBody
): TurnBody | undefined {
  return current.kind === 'turn' && !current.userItemId && next.kind === 'turn' && next.userItemId
    ? { ...current, userItemId: next.userItemId }
    : undefined
}
