import type { MobileWebAgentHistorySession } from '../../../src/shared/mobile-web/agent-history-operation-contract'
import { formatTimeAgo } from '../worktree/agent-row-display'
import type { MobileAgentHistorySection } from './agent-history-sections'

export function mobileWebAgentHistorySections(
  sessions: readonly MobileWebAgentHistorySession[],
  now: number
): MobileAgentHistorySection[] {
  const sections = new Map<string, MobileAgentHistorySection>()
  for (const session of sessions) {
    const existing = sections.get(session.groupKey)
    const section =
      existing ??
      ({
        key: session.groupKey,
        label: session.groupLabel,
        data: []
      } satisfies MobileAgentHistorySection)
    if (!existing) {
      sections.set(session.groupKey, section)
    }
    section.data.push({
      id: session.handle,
      agent: session.agent,
      agentLabel: session.agentLabel,
      title: session.title || 'Untitled session',
      lastMessage: session.lastMessage,
      messageCount: session.messageCount,
      timeAgo: session.updatedAt === null ? '' : formatTimeAgo(session.updatedAt, now),
      isCurrentWorktree: session.isCurrentWorkspace,
      resumeAvailable: session.resumeAvailable
    })
  }
  return [...sections.values()]
}
