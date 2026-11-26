import type { Repo } from '../../../shared/repository/repo-types'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'

type NamingSession = Pick<AgentSessionRecord, 'sessionId' | 'forkedFrom' | 'conversationName'>

export function chatWorkspaceNameUpdate(
  repo: Repo,
  record: NamingSession,
  submissions: readonly { sessionId: string; submittedAt: number }[]
): Pick<Repo, 'displayName' | 'chatWorkspace'> | null {
  if (!repo.chatWorkspace?.autoName || record.forkedFrom || !record.conversationName?.trim()) {
    return null
  }
  const first = submissions.toSorted(
    (a, b) => a.submittedAt - b.submittedAt || a.sessionId.localeCompare(b.sessionId)
  )[0]
  if (
    first?.sessionId !== record.sessionId ||
    repo.displayName !== repo.chatWorkspace.initialName
  ) {
    return null
  }
  return {
    displayName: record.conversationName,
    chatWorkspace: { ...repo.chatWorkspace, autoName: false }
  }
}
