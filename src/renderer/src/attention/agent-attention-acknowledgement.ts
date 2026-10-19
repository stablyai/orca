import {
  readAgentAttentionUnreadReason,
  type ReadableAgentAttentionUnread
} from './agent-attention-contract'

/** Subject-keyed turn bookkeeping the acknowledgement policy reads; no surface shape here. */
export type AgentAttentionTurnRecords = {
  liveTurns: Record<string, { stateStartedAt: number }>
  /** Turns kept after their session ended, so a finished agent can still be acknowledged. */
  retainedTurns: Record<string, { entry: { stateStartedAt: number } }>
  acknowledgedTurnStartedAt: Record<string, number>
}

export function readAgentAttentionTurnStartedAt(
  records: Pick<AgentAttentionTurnRecords, 'liveTurns' | 'retainedTurns'>,
  subjectKey: string
): number | null {
  return (
    records.liveTurns[subjectKey]?.stateStartedAt ??
    records.retainedTurns[subjectKey]?.entry.stateStartedAt ??
    null
  )
}

/** A turn is unread until acknowledged at or after its start; with no turn there is nothing to read. */
export function isAgentTurnUnacknowledged(
  acknowledgedAt: number,
  turnStartedAt: number | null | undefined
): boolean {
  return turnStartedAt != null && acknowledgedAt < turnStartedAt
}

/** Whether a subject's current turn is unread: the same records and test auto-acknowledgement clears. */
export function isAgentSubjectUnread(
  records: AgentAttentionTurnRecords,
  subjectKey: string
): boolean {
  return isAgentTurnUnacknowledged(
    records.acknowledgedTurnStartedAt[subjectKey] ?? 0,
    readAgentAttentionTurnStartedAt(records, subjectKey)
  )
}

/**
 * Subjects on the viewed surface whose current turn has not been acknowledged yet.
 *
 * Why compare stateStartedAt (not updatedAt): same-state pings must not re-trigger an ack,
 * matching the is-unvisited rule the workspace card uses.
 */
export function computeAgentAcknowledgementTargets(
  records: AgentAttentionTurnRecords,
  subjectKey: string | null
): string[] {
  if (subjectKey === null) {
    return []
  }
  const targets: string[] = []
  const acknowledgedAt = records.acknowledgedTurnStartedAt[subjectKey] ?? 0
  if (isAgentTurnUnacknowledged(acknowledgedAt, records.liveTurns[subjectKey]?.stateStartedAt)) {
    targets.push(subjectKey)
  }
  if (
    isAgentTurnUnacknowledged(
      acknowledgedAt,
      records.retainedTurns[subjectKey]?.entry.stateStartedAt
    )
  ) {
    targets.push(subjectKey)
  }
  return targets
}

/** The viewed subject when it currently holds an unread attention marker. */
export function resolveViewedUnreadSubjectKey(
  unreadBySubjectKey: Record<string, ReadableAgentAttentionUnread>,
  subjectKey: string | null
): string | null {
  if (subjectKey === null) {
    return null
  }
  return readAgentAttentionUnreadReason(unreadBySubjectKey[subjectKey]) === null ? null : subjectKey
}

/**
 * Manual mark-unread protections that no longer apply: the user moved to another subject, or
 * the agent took a new turn.
 *
 * Why keep on null: persisted UI hydrates before the turn snapshot lands, so an active subject
 * with no row yet is "not known", not "moved on"; wiping it would lose the user's mark-unread.
 */
export function computeLapsedManualUnreadProtections(
  records: Pick<AgentAttentionTurnRecords, 'liveTurns' | 'retainedTurns'> & {
    manuallyUnreadTurnStartedAt: Record<string, number>
  },
  activeSubjectKeys: ReadonlySet<string>
): string[] {
  const lapsed: string[] = []
  for (const [subjectKey, turnStartedAt] of Object.entries(records.manuallyUnreadTurnStartedAt)) {
    if (!activeSubjectKeys.has(subjectKey)) {
      lapsed.push(subjectKey)
      continue
    }
    const currentTurn = readAgentAttentionTurnStartedAt(records, subjectKey)
    if (currentTurn !== null && currentTurn !== turnStartedAt) {
      lapsed.push(subjectKey)
    }
  }
  return lapsed
}
