import {
  MobileWebAgentHistorySessionRefSchema,
  type MobileWebAgentHistorySession,
  type MobileWebAgentHistorySessionRef
} from '../../../src/shared/mobile-web/agent-history-operation-contract'
import { formatTimeAgo } from '../worktree/agent-row-display'
import type { MobileAgentHistorySection } from './agent-history-sections'

/** A list row key that both names the session for the desktop and stays unique across agents. */
export function mobileWebAgentHistorySessionKey(
  session: Pick<MobileWebAgentHistorySession, 'agent' | 'sessionId'>
): string {
  return `${session.agent}:${session.sessionId}`
}

export function parseMobileWebAgentHistorySessionKey(
  key: string
): MobileWebAgentHistorySessionRef | null {
  const separator = key.indexOf(':')
  const parsed = MobileWebAgentHistorySessionRefSchema.safeParse({
    agent: key.slice(0, Math.max(separator, 0)),
    sessionId: key.slice(separator + 1)
  })
  return parsed.success ? parsed.data : null
}

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
      id: mobileWebAgentHistorySessionKey(session),
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
