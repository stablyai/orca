import type { OrcaRuntimeService } from '../../orca-runtime'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'

/** Reveals a chat session and publishes its tab without taking focus. */
export async function publishChatTabInBackground(
  runtime: Pick<OrcaRuntimeService, 'publishStructuredAgentSessionTab' | 'chatTabPerson'>,
  host: Pick<StructuredAgentSessionHost, 'revealSession'>,
  sessionId: string
): Promise<void> {
  const revealed = await host.revealSession(sessionId)
  await runtime.publishStructuredAgentSessionTab({
    // No one asked for this tab here: it is for whom the chat was created.
    person: runtime.chatTabPerson(revealed.sessionId),
    workspaceId: revealed.workspaceId,
    sessionId: revealed.sessionId,
    agent: revealed.agent,
    activate: false
  })
}
