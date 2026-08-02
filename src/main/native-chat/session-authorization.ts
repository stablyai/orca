import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'

export type AuthorizedNativeChatSession = { transcriptPath?: string }

type Candidate = {
  agent: string | undefined
  sessionId: string
  transcriptPath?: string
  updatedAt: number
}

export function authorizeNativeChatSession(args: {
  agent: string
  sessionId: string
  transcriptPath?: string
  statuses: readonly AgentStatusIpcPayload[]
  snapshots: Iterable<RuntimeMobileSessionTabsSnapshot>
}): AuthorizedNativeChatSession | null {
  const requestedAgent = resolveNativeChatTranscriptAgent(args.agent)
  if (!requestedAgent) {
    return null
  }
  const requestedPath = args.transcriptPath?.trim()
  let match: Candidate | null = null
  for (const status of args.statuses) {
    if (status.providerSession) {
      match = selectCandidate(
        match,
        {
          agent: status.agentType,
          sessionId: status.providerSession.id,
          ...(status.providerSession.transcriptPath
            ? { transcriptPath: status.providerSession.transcriptPath.trim() }
            : {}),
          updatedAt: status.receivedAt
        },
        requestedAgent,
        args.sessionId,
        requestedPath
      )
    }
  }
  for (const snapshot of args.snapshots) {
    for (const tab of snapshot.tabs) {
      if (tab.type !== 'terminal') {
        continue
      }
      const session = tab.agentStatus?.providerSession
      if (session) {
        match = selectCandidate(
          match,
          {
            agent: tab.agentStatus?.agentType ?? tab.launchAgent,
            sessionId: session.id,
            ...(session.transcriptPath ? { transcriptPath: session.transcriptPath.trim() } : {}),
            updatedAt: tab.agentStatus?.updatedAt ?? 0
          },
          requestedAgent,
          args.sessionId,
          requestedPath
        )
      }
    }
  }
  return match ? (match.transcriptPath ? { transcriptPath: match.transcriptPath } : {}) : null
}

function selectCandidate(
  current: Candidate | null,
  candidate: Candidate,
  agent: string,
  sessionId: string,
  transcriptPath: string | undefined
): Candidate | null {
  return resolveNativeChatTranscriptAgent(candidate.agent) === agent &&
    candidate.sessionId === sessionId &&
    (transcriptPath === undefined || candidate.transcriptPath === transcriptPath) &&
    (!current || candidate.updatedAt > current.updatedAt)
    ? candidate
    : current
}
