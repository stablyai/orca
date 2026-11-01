// Shared listener internals let relays host the same pipeline without Electron.
import { clearAllListenerCaches } from '../../shared/agent-hook-listener/listener-state'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { parseFormEncodedBody } from '../../shared/agent-hook-listener/request-body'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { AgentHookServerAgentPresence } from './server/server-agent-presence'
import { isValidPaneKey } from './server/server-status-identity'

export type {
  AgentHookAuthorityAttestation,
  AgentHookAuthorityEvidence,
  AgentHookProviderSessionIdentity,
  AgentHookStatusRowMutation,
  AgentHookStatusChangeEntry,
  AgentHookStatusFreshnessObservation,
  EnrichedAgentHookEventPayload
} from './server/server-types'
export type { AgentHookSource }
export {
  CLOSED_AGENT_STATUS_TAB_IDS_MAX,
  CLOSED_AGENT_STATUS_PANE_KEYS_MAX,
  PANE_KEY_ALIASES_MAX,
  RETIRED_PANE_FENCES_MAX
} from './server/server-constants'
export { isValidPaneKey }

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

export type { HookListenerState } from '../../shared/agent-hook-listener/listener-state'
