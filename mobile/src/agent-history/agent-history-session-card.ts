import { isPathInsideOrEqual } from '../../../src/shared/cross-platform-path'
import { latestSessionConversationTurn } from '../../../src/shared/ai-vault-session-display'
import { aiVaultAgentLabel } from '../../../src/shared/ai-vault-types'
import type { AiVaultSession, AiVaultSessionOpenTab } from '../../../src/shared/ai-vault-types'
import { formatTimeAgo } from '../worktree/agent-row-display'

export type MobileAgentHistoryCard = {
  id: string
  agent: AiVaultSession['agent']
  agentLabel: string
  title: string
  lastMessage: string
  messageCount: number
  timeAgo: string
  isCurrentWorktree: boolean
  openTab: AiVaultSessionOpenTab | null
}

export type MobileAgentHistoryResumeActionState = {
  disabled: boolean
  loading: boolean
  closing?: boolean
}

// Why: a session belongs to the active worktree when its recorded cwd is inside
// (or equal to) the worktree path; session rows carry no host id, so this is a
// path-prefix check (same logic the desktop badge uses).
export function isSessionInActiveWorktree(
  session: Pick<AiVaultSession, 'cwd'>,
  activeWorktreePath: string | null
): boolean {
  if (!activeWorktreePath || !session.cwd) {
    return false
  }
  return isPathInsideOrEqual(activeWorktreePath, session.cwd)
}

export function buildMobileAgentHistoryCard(
  session: AiVaultSession,
  activeWorktreePath: string | null,
  now: number,
  closedSessionIds?: ReadonlySet<string>
): MobileAgentHistoryCard {
  const latestTurn = latestSessionConversationTurn(session)
  const updatedAtMs = Date.parse(session.updatedAt ?? session.modifiedAt)
  return {
    id: session.id,
    agent: session.agent,
    agentLabel: aiVaultAgentLabel(session.agent),
    title: session.title || 'Untitled session',
    lastMessage: latestTurn?.text.trim() ?? '',
    messageCount: session.messageCount,
    timeAgo: Number.isFinite(updatedAtMs) ? formatTimeAgo(updatedAtMs, now) : '',
    isCurrentWorktree: isSessionInActiveWorktree(session, activeWorktreePath),
    openTab: closedSessionIds?.has(session.id) ? null : (session.openTab ?? null)
  }
}

export function buildMobileAgentHistoryResumeActionState(
  sessions: readonly Pick<AiVaultSession, 'id'>[],
  resumingSessionId: string | null,
  closingSessionId: string | null = null,
  fallbackOpenTabsPending = false
): ReadonlyMap<string, MobileAgentHistoryResumeActionState> {
  const actionsLocked =
    resumingSessionId !== null || closingSessionId !== null || fallbackOpenTabsPending
  return new Map(
    sessions.map((session) => [
      session.id,
      {
        disabled: actionsLocked,
        loading: resumingSessionId === session.id,
        closing: closingSessionId === session.id
      }
    ])
  )
}
