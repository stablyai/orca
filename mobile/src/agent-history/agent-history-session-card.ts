import { isPathInsideOrEqual } from '../../../src/shared/cross-platform-path'
import { latestSessionConversationTurn } from '../../../src/shared/ai-vault-session-display'
import { aiVaultAgentLabel } from '../../../src/shared/ai-vault-types'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
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
}

export type MobileAgentHistoryResumeActionState = {
  disabled: boolean
  loading: boolean
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
  now: number
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
    isCurrentWorktree: isSessionInActiveWorktree(session, activeWorktreePath)
  }
}

export function buildMobileAgentHistoryResumeActionState(
  sessions: readonly Pick<AiVaultSession, 'id'>[],
  resumingSessionId: string | null
): ReadonlyMap<string, MobileAgentHistoryResumeActionState> {
  return new Map(
    sessions.map((session) => [
      session.id,
      {
        disabled: resumingSessionId !== null,
        loading: resumingSessionId === session.id
      }
    ])
  )
}
