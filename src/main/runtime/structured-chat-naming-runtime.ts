import {
  normalizeSourceControlAiSettings,
  resolveSourceControlActionRecipe
} from '../../shared/source-control-ai'
import { normalizeSourceControlActionRecipe } from '../../shared/source-control-ai-actions'
import {
  renderConversationNamePrompt,
  sanitizeGeneratedConversationName
} from '../../shared/conversation-name-generation'
import { chatNamingAgentTarget } from './structured-chat-naming-agent-launch'
import type { AgentLaunchProfileSettings } from '../../shared/tui-agent-launch-defaults'
import { chatNamingFailure } from '../../shared/chat-naming-failure-copy'
import { agentSessionCurrentContextRows } from '../../shared/agent-session-context-clear'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import type { StructuredChatNamingDeps } from '../native-chat/structured-chat-naming'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { firstStructuredChatNamingPrompt } from '../../shared/structured-chat-naming-eligibility'
import { firstStructuredAgentSessionPrompt } from '../../shared/structured-agent-session-first-prompt'
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
  resolveNamingEnvironment: (agent: string) => Promise<Record<string, string>>
  getAgentEnvResolvers: () => CommitMessageAgentEnvironmentResolvers | undefined
  workerTaskTitle: StructuredChatNamingDeps['workerTaskTitle']
  retitleOpenTab: StructuredChatNamingDeps['onNamed']
}

export function structuredChatNamingDeps(
  getStore: () => {
    getSettings: () => Parameters<typeof resolveTextGenerationParams>[0] &
      AgentLaunchProfileSettings &
      ReturnType<StructuredChatNamingDeps['getSettings']>
  },
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
    readJournalFirstPrompt: async (sessionId) => {
      const host = getStructuredAgentSessionHost()
      return host
        ? firstStructuredAgentSessionPrompt(
            agentSessionCurrentContextRows((await host.journalSnapshot(sessionId)).items).items
          )
        : ''
    },
    workerTaskTitle: runtime.workerTaskTitle,
    generate: async (record, firstPrompt, shouldExecute) => {
      // Unsupported execution contexts keep the seed regardless of native naming settings.
      if (record.location.wslDistro !== null) {
        return null
      }
      const workspace = await runtime.resolveWorkspace(record.location.workspaceId)
      if (workspace.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
        return null
      }
      const current = getStore().getSettings()
      const source = normalizeSourceControlAiSettings(
        current.sourceControlAi,
        current.commitMessageAi
      )
      const recipe = resolveSourceControlActionRecipe({
        settings: current,
        actionId: 'conversationName'
      })
      const useChatAgent = !recipe.agentId && !recipe.agentArgs?.trim()
      const log = { scope: 'conversation-name', sessionId: record.sessionId }
      if (useChatAgent && (record.provider === 'grok' || record.provider === 'antigravity')) {
        const generateText = getStructuredAgentSessionHost()?.deps.adapter.generateText
        try {
          if (!generateText) {
            throw new Error('Native naming is unavailable')
          }
          if (!recipe.commandInputTemplate?.trim()) {
            throw new Error('Chat name template is empty')
          }
          const output = await generateText({
            agent: record.provider,
            accountHome: record.accountHome,
            prompt: renderConversationNamePrompt({ firstPrompt }, recipe),
            shouldExecute
          })
          if (output === null) {
            return null
          }
          const name = sanitizeGeneratedConversationName(output)
          if (name) {
            return { name }
          }
          throw new Error('The naming agent returned an empty title')
        } catch (error) {
          logger.warn('Native chat naming failed', { ...log, error })
          return chatNamingFailure(record.provider === 'grok' ? 'grokFailed' : 'antigravityFailed')
        }
      }
      const settings = resolveTextGenerationParams(
        useChatAgent
          ? {
              ...current,
              sourceControlAi: {
                ...source,
                actions: {
                  ...source.actions,
                  conversationName: normalizeSourceControlActionRecipe({
                    ...recipe,
                    agentId: record.provider
                  })
                }
              }
            }
          : current,
        LOCAL_COMMIT_MESSAGE_HOST_KEY,
        'conversationName',
        null
      )
      if (!settings.ok) {
        logger.warn(settings.error, log)
        return { error: settings.error }
      }
      const target = useChatAgent
        ? await chatNamingAgentTarget(
            record,
            workspace.path,
            runtime.resolveNamingEnvironment,
            current
          )
        : await resolveGenerationTarget(workspace.path, settings.params.agentId, runtime)
      if (!target) {
        const failure = chatNamingFailure('noAgentAvailable')
        logger.warn(failure.error, log)
        return failure
      }
      const result = await generateConversationNameFromContext(
        { firstPrompt },
        settings.params,
        target,
        shouldExecute
      )
      if (result.success) {
        return { name: result.name }
      }
      logger.warn(result.error, log)
      return result.canceled ? null : { error: result.error, failureOutput: result.failureOutput }
    },
    onNamed: (workspaceId, sessionId) => {
      try {
        // Lists that show the chat without its tab, a closed one too, learn the name from the feed.
        getStructuredAgentSessionHost()?.publishConversationName(sessionId)
      } catch (error) {
        logger.warn('Chat name publication failed', {
          scope: 'conversation-name',
          sessionId,
          error
        })
      }
      runtime.retitleOpenTab(workspaceId, sessionId)
    },
    logger
  }
}
