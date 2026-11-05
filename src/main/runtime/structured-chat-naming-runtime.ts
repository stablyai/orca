import { normalizeSourceControlAiSettings } from '../../shared/source-control/ai/settings/source-control-ai-settings'
import { resolveSourceControlActionRecipe } from '../../shared/source-control/ai/source-control-ai-operation-policy'
import { normalizeSourceControlActionRecipe } from '../../shared/source-control/ai/recipes/source-control-ai-actions'
import {
  renderConversationNamePrompt,
  sanitizeGeneratedConversationName
} from '../../shared/source-control/ai/generation/conversation-name-generation'
import { chatNamingAgentTarget } from './structured-chat-naming-agent-launch'
import type { AgentLaunchProfileSettings } from '../../shared/agent-launch/choices/tui-agent-launch-defaults'
import { chatNamingFailure } from '../../shared/chat-naming-failure-copy'
import { agentSessionCurrentContextRows } from '../../shared/agent-session/agent-session-context-clear'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import type { StructuredChatNamingDeps } from '../native-chat/structured-chat-naming'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { firstStructuredChatNamingPrompt } from '../../shared/structured-chat-naming-eligibility'
import { firstStructuredAgentSessionPrompt } from '../../shared/agent-session/requests/structured-agent-session-first-prompt'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from '../../shared/source-control/ai/generation/commit-message-host-key'
import {
  generateConversationNameFromContext,
  resolveTextGenerationParams
} from '../text-generation/commit-message-text-generation'
import { resolveGenerationTarget } from '../agent-hooks/first-work-generation-target'
import { createResolvedTextGenerationParamsFence } from '../text-generation/text-generation-settings-fence'
import { textGenerationFailure } from '../../shared/text-generation-failure-copy'
import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from '../text-generation/source-control-generation-limits'

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
        ? firstStructuredChatNamingPrompt(await host.journalCurrentRead(sessionId), hostStartedAt)
        : ''
    },
    readJournalFirstPrompt: async (sessionId) => {
      const host = getStructuredAgentSessionHost()
      return host
        ? firstStructuredAgentSessionPrompt(
            agentSessionCurrentContextRows((await host.journalCurrentRead(sessionId)).items).items
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
      const settingsCurrent = useChatAgent
        ? () => true
        : createResolvedTextGenerationParamsFence(
            () => getStore().getSettings(),
            { settings: current, resolved: settings },
            LOCAL_COMMIT_MESSAGE_HOST_KEY,
            'conversationName',
            null
          )
      const target = useChatAgent
        ? await chatNamingAgentTarget(
            record,
            workspace.path,
            runtime.resolveNamingEnvironment,
            current
          )
        : await resolveGenerationTarget(workspace.path, settings.params.agentId, runtime, {
            operation: 'conversation-name',
            params: settings.params,
            ownerId: record.sessionId,
            canFailover: !!shouldExecute,
            current: () => (!shouldExecute || shouldExecute()) && settingsCurrent(),
            validate: async () => {
              try {
                const latest = await runtime.resolveWorkspace(record.location.workspaceId)
                return (
                  latest.path === workspace.path &&
                  latest.executionHostId === workspace.executionHostId
                )
              } catch {
                return false
              }
            }
          })
      if (!target) {
        const failure = chatNamingFailure('noAgentAvailable')
        logger.warn(failure.error, log)
        return failure
      }
      try {
        const result = await generateConversationNameFromContext(
          { firstPrompt },
          settings.params,
          target,
          shouldExecute
        )
        const request = target.kind === 'local' ? target.request : undefined
        if (request && !(await request.validate())) {
          const timedOut = request.signal.aborted
            ? request.signal.reason === 'deadline'
            : Date.now() >= request.deadline
          // Only Stop or ownership loss is silent; an expired budget keeps naming retry/backoff.
          if (!timedOut || !request.ownsResult()) {
            return null
          }
          const failure =
            result.success || result.canceled
              ? textGenerationFailure('timedOut', {
                  seconds: SOURCE_CONTROL_GENERATION_TIMEOUT_MS / 1000
                })
              : result
          logger.warn(failure.error, log)
          return {
            error: failure.error,
            failureOutput: result.success ? undefined : result.failureOutput
          }
        }
        if (result.success) {
          return { name: result.name }
        }
        logger.warn(result.error, log)
        return result.canceled ? null : { error: result.error, failureOutput: result.failureOutput }
      } finally {
        if (target.kind === 'local') {
          target.request?.finish()
        }
      }
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
