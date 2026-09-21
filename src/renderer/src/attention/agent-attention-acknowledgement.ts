import {
  readAgentAttentionUnreadReason,
  type AgentAttentionRemainder,
  type ReadableAgentAttentionUnread
} from './agent-attention-contract'

/** Subject-keyed turn bookkeeping the acknowledgement policy reads; no surface shape here. */
export type AgentAttentionTurnRecords = {
  liveTurns: Record<string, { stateStartedAt: number }>
  /** Turns kept after their session ended, so a finished agent can still be acknowledged. */
  retainedTurns: Record<string, { entry: { stateStartedAt: number } }>
  acknowledgedTurnStartedAt: Record<string, number>
}

export type AgentAttentionAcknowledgementSink = {
  acknowledgeSubjects: (subjectKeys: string[]) => void
  clearWorkspaceUnread: (workspaceId: string) => void
  clearGroupUnread: (groupId: string) => void
  clearSubjectUnread: (subjectKey: string) => void
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
  const liveTurn = records.liveTurns[subjectKey]
  if (liveTurn && acknowledgedAt < liveTurn.stateStartedAt) {
    targets.push(subjectKey)
  }
  const retainedTurn = records.retainedTurns[subjectKey]
  if (retainedTurn && acknowledgedAt < retainedTurn.entry.stateStartedAt) {
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

/**
 * One workspace's attention as every surface kind sees it.
 *
 * Why a union: workspace unread is owned by the workspace, not by a surface kind, so a surface
 * that can only see its own tabs would report a sibling of another kind as absent and let the
 * clear through. A workspace owns surfaces when any kind owns one.
 */
export function mergeAgentAttentionRemainders(
  remainders: readonly AgentAttentionRemainder[]
): AgentAttentionRemainder {
  return {
    hasSurfaces: remainders.some((remainder) => remainder.hasSurfaces),
    unreadSubjectKeys: remainders.flatMap((remainder) => [...remainder.unreadSubjectKeys]),
    unreadGroupIds: remainders.flatMap((remainder) => [...remainder.unreadGroupIds])
  }
}

/**
 * Workspace unread is coarse, so a hidden sibling still wanting attention keeps it lit even
 * while the user acknowledges the subject in front of them.
 */
export function shouldClearWorkspaceAttention(
  remainder: AgentAttentionRemainder,
  args: { viewedGroupId: string; clearedSubjectKeys: ReadonlySet<string> }
): boolean {
  if (!remainder.hasSurfaces) {
    return true
  }
  for (const subjectKey of remainder.unreadSubjectKeys) {
    if (!args.clearedSubjectKeys.has(subjectKey)) {
      return false
    }
  }
  for (const groupId of remainder.unreadGroupIds) {
    if (groupId !== args.viewedGroupId) {
      return false
    }
  }
  return true
}

export function applyAgentAttentionAcknowledgement(
  sink: AgentAttentionAcknowledgementSink,
  args: {
    /** Null when a hidden sibling still owns the workspace's attention. */
    workspaceIdToClear: string | null
    viewedGroupId: string
    subjectKeys: string[]
    viewedUnreadSubjectKey?: string | null
  }
): void {
  const subjectKeysToClear = new Set(args.subjectKeys)
  if (args.viewedUnreadSubjectKey) {
    subjectKeysToClear.add(args.viewedUnreadSubjectKey)
  }

  if (args.subjectKeys.length === 0 && subjectKeysToClear.size === 0) {
    return
  }

  if (args.subjectKeys.length > 0) {
    sink.acknowledgeSubjects(args.subjectKeys)
  }
  if (args.workspaceIdToClear !== null) {
    // Why: the selected agent is now visible, so drop the Dock-driving workspace unread.
    sink.clearWorkspaceUnread(args.workspaceIdToClear)
  }
  sink.clearGroupUnread(args.viewedGroupId)
  for (const subjectKey of subjectKeysToClear) {
    sink.clearSubjectUnread(subjectKey)
  }
}
