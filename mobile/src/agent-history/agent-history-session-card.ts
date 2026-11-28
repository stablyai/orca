import { isPathInsideOrEqual } from '../../../src/shared/file-access/cross-platform-path'
import { latestSessionConversationTurn } from '../../../src/shared/ai-vault/session-display/ai-vault-session-display'
import {
  aiVaultAgentLabel,
  type AiVaultSession
} from '../../../src/shared/ai-vault/contracts/ai-vault-types'

import { aiVaultSessionMessageCountKnown } from '../../../src/shared/ai-vault/session-display/cursor-acp-session-path'
import { formatTimeAgo } from '../worktree/agent-lineage/agent-row-display'
import type { Translate } from '../i18n/mobile-i18n'

export type MobileAgentHistoryCard = {
  id: string
  agent: AiVaultSession['agent']
  agentLabel: string
  title: string
  /** The session is a forked chat, so its title follows the fork mark. */
  forked: boolean
  lastMessage: string
  /** Null when the host cannot count this conversation. */
  messageCount: number | null
  timeAgo: string
  isCurrentWorktree: boolean
}

export type MobileAgentHistoryResumeActionState = {
  disabled: boolean
  loading: boolean
}

// No host id in session rows; current-worktree membership uses equal/descendant cwd prefix, matching desktop.
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
  session: AiVaultSession & { forked?: true },
  activeWorktreePath: string | null,
  now: number,
  t: Translate
): MobileAgentHistoryCard {
  const latestTurn = latestSessionConversationTurn(session)
  const updatedAtMs = Date.parse(session.updatedAt ?? session.modifiedAt)
  return {
    id: session.id,
    agent: session.agent,
    agentLabel: aiVaultAgentLabel(session.agent),
    title: session.title || t('agentHistory.sessionCard.untitledSession', 'Untitled session'),
    forked: session.forked === true,
    lastMessage: latestTurn?.text.trim() ?? '',
    messageCount: aiVaultSessionMessageCountKnown(session) ? session.messageCount : null,
    timeAgo: Number.isFinite(updatedAtMs) ? formatTimeAgo(updatedAtMs, now, t) : '',
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
