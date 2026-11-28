import {
  readAgentAttentionUnreadReason,
  type ReadableAgentAttentionUnread
} from './agent-attention-contract'
import { CHAT_PANE_ADDRESS_PREFIX } from '../../../shared/agent-session/view/structured-agent-session-projection'
import {
  chatReadMarkAliases,
  hasLoadedChatReadMarkAliases,
  knownChatReadMarkKey,
  readWebChatMark
} from '@/store/slices/agent-status/structured-sessions/chat-read-mark-aliases'

export type AgentAttentionTurn = {
  stateStartedAt: number
  state?: string
  sessionBoundary?: boolean
  restoredUnconfirmed?: boolean
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
  const entry = agentAttentionTurnEntry(records.liveTurns, subjectKey)
  return entry ? agentAttentionTurnAt(entry) : null
}

export function readManualUnreadProtectionTurn(
  records: Pick<AgentAttentionTurnRecords, 'liveTurns'>,
  subjectKey: string
): number | null {
  const entry = agentAttentionTurnEntry(records.liveTurns, subjectKey)
  if (!entry) {
    return null
  }
  const turn = agentAttentionTurnAt(entry)
  if (
    subjectKey.startsWith(CHAT_PANE_ADDRESS_PREFIX) &&
    (entry.restoredUnconfirmed || !Number.isFinite(turn) || turn <= 0)
  ) {
    return null
  }
  return turn
}

function agentAttentionTurnEntry(
  turns: AgentAttentionTurnRecords['liveTurns'],
  subjectKey: string
): AgentAttentionTurn | undefined {
  return isTurnMap(turns) ? turns.get(subjectKey) : turns[subjectKey]
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
  const { manuallyUnreadTurnStartedAt: marks } = records
  const keys = Object.keys(marks)
  if (keys.length === 0) {
    return []
  }
  const field = 'manuallyUnreadTurnsByPaneKey'
  const activeChatAliases = hasLoadedChatReadMarkAliases() ? new Map<string, string>() : undefined
  if (activeChatAliases) {
    for (const key of activeSubjectKeys) {
      for (const alias of chatReadMarkAliases(field, key) ?? []) {
        activeChatAliases.set(alias, key)
      }
    }
  }
  const seen = activeChatAliases ? new Set<string>() : undefined
  const markRecords = { manuallyUnreadTurnsByPaneKey: marks }
  const lapsed: string[] = []
  for (const physicalKey of keys) {
    const key =
      activeChatAliases?.get(physicalKey) ?? knownChatReadMarkKey(field, physicalKey) ?? physicalKey
    if (seen?.has(key)) {
      continue
    }
    seen?.add(key)
    const currentTurn = readManualUnreadProtectionTurn(records, key)
    if (
      !activeSubjectKeys.has(key) ||
      (currentTurn !== null &&
        readWebChatMark(markRecords, field, key, currentTurn) !== currentTurn)
    ) {
      lapsed.push(key)
    }
  }
  return lapsed
}
