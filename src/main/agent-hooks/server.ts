// This main-process adapter keeps listener internals in shared/ so the relay can host the same pipeline without Electron.
import { join } from 'node:path'
import { clearAllListenerCaches } from '../../shared/agent-hook-listener/listener-state'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { parseFormEncodedBody } from '../../shared/agent-hook-listener/request-body'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { AgentHookServerLifecycle } from './server/server-lifecycle'
import { isValidPaneKey } from './server/server-status-identity'
import {
  type NativeChatHookActivityStore,
  nativeChatHookActivityStore
} from '../native-chat/hook-activity-store'

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
export class AgentHookServer extends AgentHookServerLifecycle {
  constructor(private readonly nativeChatActivity: NativeChatHookActivityStore | null = null) {
    super()
    if (nativeChatActivity) {
      this.subscribeEnrichedStatus((event) => nativeChatActivity.ingest(event))
    }
  }

  override async start(options?: {
    env?: string
    userDataPath?: string
    endpointNamespace?: string
  }): Promise<void> {
    if (this.server) {
      return
    }
    this.nativeChatActivity?.reset()
    if (options?.userDataPath) {
      this.configureEndpointPaths(options.userDataPath, options.endpointNamespace)
    }
    this.nativeChatActivity?.setRoot(
      this.endpointDir ? join(this.endpointDir, 'native-chat-activity') : null
    )
    await super.start(options)
  }

  override stop(): void {
    super.stop()
    this.nativeChatActivity?.reset()
  }
}

export const agentHookServer = new AgentHookServer(nativeChatHookActivityStore)

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
