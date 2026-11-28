// A device's `agentSession.create` of a new codex chat, signed as the client signs it.
import { randomUUID } from 'node:crypto'
import { structuredAgentSessionCreateFingerprint } from '../../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import { stubUserData } from './teammate-tabs.test-support'

export async function createChatAs(
  call: (deviceId: string, method: string, params: unknown) => Promise<unknown>,
  deviceId: string,
  where: string,
  tabPlacement?: { afterTabId: string }
): Promise<string> {
  // The agent's runtime home is made under the app's data folder: the test's own.
  stubUserData()
  const sessionId = randomUUID()
  await call(deviceId, 'agentSession.create', {
    envelope: {
      sessionId,
      clientOperationId: `${Date.now()}-${randomUUID().replaceAll('-', '')}`,
      expectedRuntimeFence: null,
      payloadFingerprint: structuredAgentSessionCreateFingerprint({
        sessionId,
        worktree: where,
        agent: 'codex'
      })
    },
    worktree: where,
    agent: 'codex',
    ...(tabPlacement ? { tabPlacement } : {})
  })
  return sessionId
}
