import {
  filterAiVaultSessions,
  groupAiVaultSessions
} from '../../../../shared/ai-vault-session-filters'
import {
  latestSessionConversationTurn,
  recentSessionConversationTurns
} from '../../../../shared/ai-vault-session-display'
import {
  AI_VAULT_AGENTS,
  aiVaultAgentLabel,
  type AiVaultScope,
  type AiVaultSession
} from '../../../../shared/ai-vault-types'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import {
  MOBILE_WEB_AGENT_HISTORY_PREVIEW_LIMIT,
  MobileWebAgentHistoryPreviewResultSchema,
  MobileWebAgentHistorySessionSchema,
  type MobileWebAgentHistoryPreviewResult,
  type MobileWebAgentHistorySession
} from '../../../../shared/mobile-web/agent-history-operation-contract'

export function filterMobileWebAgentHistorySessions(
  sessions: readonly AiVaultSession[],
  args: { scope: AiVaultScope; query: string; scopePaths: readonly string[] }
): AiVaultSession[] {
  const narrowByPath = args.scope !== 'all' && args.scopePaths.length > 0
  return filterAiVaultSessions(sessions, {
    query: args.query,
    agents: AI_VAULT_AGENTS,
    scope: narrowByPath ? 'workspace' : 'all',
    sort: 'updated',
    activeWorktreePaths: narrowByPath ? args.scopePaths : [],
    hideEmptySessions: true
  })
}

/** Projects host sessions into bounded, path-free rows: the page sees a handle, never a cwd. */
export function projectMobileWebAgentHistory(args: {
  sessions: readonly AiVaultSession[]
  activeWorktreePath: string | null
}): MobileWebAgentHistorySession[] {
  return groupAiVaultSessions(args.sessions, 'folder').flatMap((group, groupIndex) =>
    group.sessions.map((session) =>
      MobileWebAgentHistorySessionSchema.parse({
        sessionId: session.sessionId,
        agent: session.agent,
        agentLabel: aiVaultAgentLabel(session.agent),
        title: boundedText(session.title || 'Untitled session', 512),
        lastMessage: boundedText(latestSessionConversationTurn(session)?.text.trim() ?? '', 2_048),
        messageCount: boundedCount(session.messageCount, 1_000_000),
        updatedAt: timestamp(session.updatedAt ?? session.modifiedAt),
        groupKey: `group_${groupIndex.toString(36)}`,
        groupLabel: boundedText(group.label, 240),
        isCurrentWorkspace: isSessionInWorktree(session, args.activeWorktreePath),
        resumeAvailable: session.sessionId.trim().length > 0
      })
    )
  )
}

export function projectMobileWebAgentHistoryPreview(
  session: AiVaultSession
): MobileWebAgentHistoryPreviewResult {
  return MobileWebAgentHistoryPreviewResultSchema.parse({
    messages: recentSessionConversationTurns(session, MOBILE_WEB_AGENT_HISTORY_PREVIEW_LIMIT).map(
      (message) => ({ role: message.role, text: boundedText(message.text, 4_096) })
    )
  })
}

export function boundedCount(value: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(0, Math.trunc(value))) : 0
}

function isSessionInWorktree(
  session: Pick<AiVaultSession, 'cwd'>,
  activeWorktreePath: string | null
): boolean {
  return Boolean(
    activeWorktreePath && session.cwd && isPathInsideOrEqual(activeWorktreePath, session.cwd)
  )
}

function timestamp(value: string | null): number | null {
  if (!value) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, Number.MAX_SAFE_INTEGER) : null
}

function boundedText(value: string, maximum: number): string {
  return value.slice(0, maximum)
}
