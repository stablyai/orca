import type { Store } from '../persistence'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import type { StructuredChatNamingDeps } from '../native-chat/structured-chat-naming'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { firstStructuredChatNamingPrompt } from '../../shared/structured-chat-naming-eligibility'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from '../../shared/commit-message-host-key'
import {
  generateConversationNameFromContext,
  resolveTextGenerationParams
} from '../text-generation/commit-message-text-generation'
import { resolveGenerationTarget } from '../agent-hooks/first-work-generation-target'

type StructuredChatNamingRuntime = {
  resolveWorkspace: (
    workspaceId: string
  ) => Promise<{ path: string; executionHostId: ExecutionHostId }>
  getAgentEnvResolvers: () => CommitMessageAgentEnvironmentResolvers | undefined
  hasOpenDispatch: StructuredChatNamingDeps['hasOpenDispatch']
  onNamed: StructuredChatNamingDeps['onNamed']
}

export function structuredChatNamingDeps(
  getStore: () => Pick<Store, 'getSettings'>,
  runtime: StructuredChatNamingRuntime,
  logger: StructuredAgentSessionLogger
): StructuredChatNamingDeps {
  return {
    getStore: () => getStructuredAgentSessionHost()?.deps.store ?? null,
    getSettings: () => getStore().getSettings(),
    readFirstPrompt: async (sessionId, hostStartedAt) => {
      const host = getStructuredAgentSessionHost()
      return host
        ? firstStructuredChatNamingPrompt(await host.journalSnapshot(sessionId), hostStartedAt)
        : ''
    },
    hasOpenDispatch: runtime.hasOpenDispatch,
    generate: async (record, firstPrompt) => {
      const settings = resolveTextGenerationParams(
        getStore().getSettings(),
        LOCAL_COMMIT_MESSAGE_HOST_KEY,
        'conversationName',
        null
      )
      if (!settings.ok) {
        logger.warn(settings.error, { scope: 'conversation-name', sessionId: record.sessionId })
        return null
      }
      const workspace = await runtime.resolveWorkspace(record.location.workspaceId)
      // Structured chats execute natively on this host; an SSH workspace must never fall back here.
      if (
        workspace.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
        record.location.wslDistro !== null
      ) {
        throw new Error('Chat name generation target is not this native execution host')
      }
      const target = await resolveGenerationTarget(
        workspace.path,
        settings.params.agentId,
        null,
        runtime
      )
      if (!target) {
        return null
      }
      const result = await generateConversationNameFromContext(
        { firstPrompt },
        settings.params,
        target
      )
      if (!result.success) {
        logger.warn(result.error, { scope: 'conversation-name', sessionId: record.sessionId })
        return null
      }
      return result.name
    },
    onNamed: runtime.onNamed,
    logger
  }
}
