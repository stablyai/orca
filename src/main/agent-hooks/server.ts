// Shared listener internals let relays host the same pipeline without Electron.
import { clearAllListenerCaches } from '../../shared/agent-hook-listener/listener-state'
import { normalizeHookPayload } from '../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import { parseFormEncodedBody } from '../../shared/agent-hook-listener/request-body'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../../shared/agent-hook-listener/transport/agent-hook-relay'
import { AgentHookServerAgentPresence } from './server/server-agent-presence'

export class AgentHookServer extends AgentHookServerAgentPresence {}

export const agentHookServer = new AgentHookServer()

export const _internals = {
  // Bind normalization to singleton state so tests exercise its caches.
  normalizeHookPayload: (
    source: AgentHookSource,
    body: unknown,
    expectedEnv: string
  ): AgentHookEventPayload | null =>
    normalizeHookPayload(agentHookServer._getStateForTests(), source, body, expectedEnv),
  parseFormEncodedBody,
  resetCachesForTests: (): void => {
    clearAllListenerCaches(agentHookServer._getStateForTests())
    agentHookServer._resetCanonicalStatusForTests()
    agentHookServer._resetRowOwnershipForTests()
    agentHookServer._resetPromptSentDedupeForTests()
    agentHookServer._resetConnectionTimestampWatermarksForTests()
  }
}
