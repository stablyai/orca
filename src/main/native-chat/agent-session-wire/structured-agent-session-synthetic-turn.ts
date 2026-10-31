import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { revisedAgentJournalTurnAnchor } from '../../../shared/agent-session-turn-record'

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

/** Orca settled it, or its interruption still lacks a verdict: a later read may still end it. */
export function turnRecordRevisitable(body: AgentJournalItemBody | undefined): boolean {
  return isSyntheticInterruptedTurn(body) || isUnexplainedInterruptedTurn(body)
}

/**
 * What a direct batch writes over a saved row: a turn record its newer evidence may replace, keeping
 * the opener the record names (`revisedAgentJournalTurnAnchor`), or a saved record that only learns
 * or canonicalizes its opener. Anything else stays.
 */
export function revisedTurnRecord(
  current: { itemId: string; body: AgentJournalItemBody },
  next: AgentJournalItemBody,
  savedRow: (key: string) => string | undefined
): AgentJournalItemBody | undefined {
  if (current.body.kind !== 'turn' || next.kind !== 'turn') {
    return undefined
  }
  const saved = current.body.userItemId
  const userItemId = revisedAgentJournalTurnAnchor(current.itemId, saved, next.userItemId, savedRow)
  const anchored = (body: TurnBody): TurnBody => (userItemId ? { ...body, userItemId } : body)
  if (turnRecordReplaceable(current.body, next)) {
    return anchored(next)
  }
  return userItemId !== saved ? anchored(current.body) : undefined
}
