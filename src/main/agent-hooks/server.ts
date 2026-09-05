// This main-process adapter keeps listener internals in shared/ so the relay can host the same pipeline without Electron.
import { clearAllListenerCaches } from '../../shared/agent-hook-listener/listener-state'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { parseFormEncodedBody } from '../../shared/agent-hook-listener/request-body'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { AgentHookServerLifecycle } from './server/server-lifecycle'
import { isValidPaneKey } from './server/server-status-identity'

export type {
  AgentHookAuthorityAttestation,
  AgentHookAuthorityEvidence,
  AgentHookProviderSessionIdentity,
  AgentHookStatusChangeEntry,
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

/** Public composition seam for the loopback hook listener and relay status adapter. */
export class AgentHookServer extends AgentHookServerLifecycle {}

export const agentHookServer = new AgentHookServer()

// Why: exported for test coverage of the per-agent field extractors.
export const _internals = {
  // Why: bind the test-helper to the singleton's state so tests exercise the live caches.
  normalizeHookPayload: (
    source: AgentHookSource,
    body: unknown,
    expectedEnv: string
  ): AgentHookEventPayload | null =>
    normalizeHookPayload(agentHookServer._getStateForTests(), source, body, expectedEnv),
  parseFormEncodedBody,
  resetCachesForTests: (): void => {
    clearAllListenerCaches(agentHookServer._getStateForTests())
    agentHookServer._resetPromptSentDedupeForTests()
    agentHookServer._resetConnectionTimestampWatermarksForTests()
  }
}

export type { HookListenerState } from '../../shared/agent-hook-listener/listener-state'
