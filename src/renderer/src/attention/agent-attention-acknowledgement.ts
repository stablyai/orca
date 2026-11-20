import {
  readAgentAttentionUnreadReason,
  type ReadableAgentAttentionUnread
} from './agent-attention-contract'

export type AgentAttentionTurn = {
  stateStartedAt: number
  state?: string
  sessionBoundary?: boolean
  stateHistory?: readonly { startedAt: number }[]
}

/** Subject-keyed turn bookkeeping the acknowledgement policy reads; no surface shape here. */
export type AgentAttentionTurnRecords = {
  liveTurns: ReadonlyMap<string, AgentAttentionTurn> | Record<string, AgentAttentionTurn>
  acknowledgedTurnStartedAt: Record<string, number>
}

/** A session-boundary idle restates the turn it displaced, so it keeps that turn's identity instead of its arrival time. */
export function agentAttentionTurnAt(entry: AgentAttentionTurn): number {
  if (entry.state !== 'done' || entry.sessionBoundary !== true) {
    return entry.stateStartedAt
  }
  return entry.stateHistory?.at(-1)?.startedAt ?? 0
}

export function readAgentAttentionTurnStartedAt(
  records: Pick<AgentAttentionTurnRecords, 'liveTurns'>,
  subjectKey: string
): number | null {
  const turns = records.liveTurns
  const entry = isTurnMap(turns) ? turns.get(subjectKey) : turns[subjectKey]
  return entry ? agentAttentionTurnAt(entry) : null
}

function isTurnMap(
  turns: AgentAttentionTurnRecords['liveTurns']
): turns is ReadonlyMap<string, AgentAttentionTurn> {
  return typeof turns.get === 'function'
}

/** A turn is unread until acknowledged at or after its start; with no turn there is nothing to read. */
export function isAgentTurnUnacknowledged(
  acknowledgedAt: number,
  turnStartedAt: number | null | undefined
): boolean {
  return turnStartedAt != null && acknowledgedAt < turnStartedAt
}

/** Read the same current-turn records that auto-acknowledgement clears. */
export function isAgentSubjectUnread(
  records: AgentAttentionTurnRecords,
  subjectKey: string
): boolean {
  return isAgentTurnUnacknowledged(
    records.acknowledgedTurnStartedAt[subjectKey] ?? 0,
    readAgentAttentionTurnStartedAt(records, subjectKey)
  )
}

/** Acknowledge viewed subjects by stateStartedAt, not updatedAt, so same-state pings cannot retrigger acknowledgement. */
export function computeAgentAcknowledgementTargets(
  records: AgentAttentionTurnRecords,
  subjectKey: string | null
): string[] {
  if (subjectKey === null) {
    return []
  }
  const targets: string[] = []
  const acknowledgedAt = records.acknowledgedTurnStartedAt[subjectKey] ?? 0
  if (
    isAgentTurnUnacknowledged(acknowledgedAt, readAgentAttentionTurnStartedAt(records, subjectKey))
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

/** Expire manual-unread protection after a subject switch or new turn. Keep it on missing rows: UI hydrates before turn snapshots, so absence does not prove a switch. */
export function computeLapsedManualUnreadProtections(
  records: Pick<AgentAttentionTurnRecords, 'liveTurns'> & {
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
