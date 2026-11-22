// A chat whose host waits on an async question, for fixtures: its status feed holds the summary and
// the local host saves Skip, with no runtime behind either.
import { getStructuredAgentSessionStatusFeed } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { AGENT_SESSION_SKIP_ASYNC_QUESTIONS_RUNTIME_CAPABILITY } from '../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session/agent-session-wire'

export function stubAwaitedQuestion(sessionId: string, itemId: string, text: string): void {
  setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_SKIP_ASYNC_QUESTIONS_RUNTIME_CAPABILITY])
  const summary: AgentSessionStatusSummary = {
    sessionId,
    workspaceId: 'fixture',
    agent: 'codex',
    status: 'idle',
    latestPrompt: '',
    updatedAt: 0,
    awaitsAnswer: true,
    awaitsQuestion: { itemId, text }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the feed's live map, written as a host update would.
  const snapshot = getStructuredAgentSessionStatusFeed({ kind: 'local' }).getSnapshot() as Map<
    string,
    AgentSessionStatusSummary
  >
  snapshot.set(sessionId, summary)
}
