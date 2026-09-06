import {
  filterAiVaultSessions,
  groupAiVaultSessions
} from '../../../src/shared/ai-vault-session-filters'
import {
  latestSessionConversationTurn,
  recentSessionConversationTurns
} from '../../../src/shared/ai-vault-session-display'
import {
  AI_VAULT_AGENTS,
  aiVaultAgentLabel,
  type AiVaultScanIssue,
  type AiVaultScope,
  type AiVaultSession
} from '../../../src/shared/ai-vault-types'
import {
  MobileWebAgentHistoryPreviewResultSchema,
  MobileWebAgentHistorySessionSchema,
  type MobileWebAgentHistoryPreviewResult,
  type MobileWebAgentHistorySession
} from '../../../src/shared/mobile-web/agent-history-operation-contract'
import { isSessionInActiveWorktree } from '../agent-history/agent-history-session-card'
import type { MobileWebAgentHistoryAuthority } from './mobile-web-agent-history-authority'

export function mobileWebAgentHistoryPresentation(args: {
  sessions: readonly AiVaultSession[]
  issues: readonly AiVaultScanIssue[]
  scope: AiVaultScope
  query: string
  scopePaths: readonly string[]
  activeWorktreePath: string | null
  authority: MobileWebAgentHistoryAuthority
}): { sessions: MobileWebAgentHistorySession[]; skippedTranscriptCount: number } {
  const narrowByPath = args.scope !== 'all' && args.scopePaths.length > 0
  const filtered = filterAiVaultSessions(args.sessions, {
    query: args.query,
    agents: AI_VAULT_AGENTS,
    scope: narrowByPath ? 'workspace' : 'all',
    sort: 'updated',
    activeWorktreePaths: narrowByPath ? args.scopePaths : [],
    hideEmptySessions: true
  })
  args.authority.synchronize(filtered)
  const groups = groupAiVaultSessions(filtered, 'folder')
  const projected = groups.flatMap((group, groupIndex) =>
    group.sessions.map((session) =>
      MobileWebAgentHistorySessionSchema.parse({
        handle: args.authority.pageHandle(session.id),
        agent: session.agent,
        agentLabel: aiVaultAgentLabel(session.agent),
        title: boundedText(session.title || 'Untitled session', 512),
        lastMessage: boundedText(latestSessionConversationTurn(session)?.text.trim() ?? '', 2_048),
        messageCount: boundedCount(session.messageCount, 1_000_000),
        updatedAt: timestamp(session.updatedAt ?? session.modifiedAt),
        groupKey: `group_${groupIndex.toString(36)}`,
        groupLabel: boundedText(group.label, 240),
        isCurrentWorkspace: isSessionInActiveWorktree(session, args.activeWorktreePath),
        resumeAvailable: session.sessionId.trim().length > 0
      })
    )
  )
  return {
    sessions: projected,
    skippedTranscriptCount: boundedCount(args.issues.length, 10_000)
  }
}

export function mobileWebAgentHistoryPreview(
  session: AiVaultSession
): MobileWebAgentHistoryPreviewResult {
  return MobileWebAgentHistoryPreviewResultSchema.parse({
    messages: recentSessionConversationTurns(session, 5).map((message) => ({
      role: message.role,
      text: boundedText(message.text, 4_096)
    }))
  })
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

function boundedCount(value: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(0, Math.trunc(value))) : 0
}
