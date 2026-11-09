import { normalizeSourceControlAiSettings } from '../../../../shared/source-control/ai/settings/source-control-ai-settings'
import {
  resolveSourceControlActionRecipe,
  resolveInstructionsFromNormalized
} from '../../../../shared/source-control/ai/source-control-ai-operation-policy'
import { readSourceControlAiModelChoiceForHost } from '../../../../shared/source-control/ai/settings/source-control-ai-model-selection'
import { normalizeSourceControlActionRecipe } from '../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import {
  renderConversationNamePrompt,
  sanitizeGeneratedConversationName
} from '../../../../shared/source-control/ai/generation/conversation-name-generation'
import { chatNamingAgentTarget } from './structured-chat-naming-agent-launch'
import type { AgentLaunchProfileSettings } from '../../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import { chatNamingFailure } from '../../../../shared/chat-naming-failure-copy'
import { agentSessionCurrentContextRows } from '../../../../shared/agent-session/agent-session-context-clear'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { CommitMessageAgentEnvironmentResolvers } from '../../../text-generation/commit-message-agent-environment'
import type { StructuredChatNamingDeps } from '../../../native-chat/structured-chat-naming'
import type { StructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { firstStructuredChatNamingPrompt } from '../../../../shared/structured-chat-naming-eligibility'
import { firstStructuredAgentSessionPrompt } from '../../../../shared/agent-session/requests/structured-agent-session-first-prompt'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from '../../../../shared/source-control/ai/generation/commit-message-host-key'
import {
  generateConversationNameFromContext,
  resolveTextGenerationParams
} from '../../../text-generation/commit-message-text-generation'
import { resolveGenerationTarget } from '../../../agent-hooks/first-work/first-work-generation-target'

type StructuredChatNamingRuntime = {
  resolveWorkspace: (
    workspaceId: string
  ) => Promise<{ path: string; executionHostId: ExecutionHostId }>
  resolveNamingEnvironment: (agent: string) => Promise<Record<string, string>>
  getAgentEnvResolvers: () => CommitMessageAgentEnvironmentResolvers | undefined
  workerTaskTitle: StructuredChatNamingDeps['workerTaskTitle']
  retitleOpenTab: StructuredChatNamingDeps['onNamed']
}

function canReuseClaudeTitle(
  current: Parameters<typeof resolveTextGenerationParams>[0],
  model: string
): boolean {
  const source = normalizeSourceControlAiSettings(current.sourceControlAi, current.commitMessageAi)
  const recipe = resolveSourceControlActionRecipe({
    settings: current,
    actionId: 'conversationName'
  })
  const override = source.modelOverridesByOperation?.conversationName
  const choices = [override, source, current.commitMessageAi]
  return (
    !recipe.agentId &&
    !recipe.agentArgs?.trim() &&
    recipe.commandInputTemplate === '{basePrompt}' &&
    !resolveInstructionsFromNormalized(source, null, 'conversationName', undefined) &&
    !choices.some(
      (choice) =>
        readSourceControlAiModelChoiceForHost(choice, LOCAL_COMMIT_MESSAGE_HOST_KEY, 'claude') !==
        undefined
    ) &&
    (override?.selectedThinkingByModel?.[model] ??
      source.selectedThinkingByModel[model] ??
      current.commitMessageAi?.selectedThinkingByModel?.[model]) === undefined
  )
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
    generate: async function generate(record, firstPrompt, shouldExecute, automaticTitle) {
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
      if (
        automaticTitle &&
        record.provider === 'claude' &&
        current.nativeChatAutoName !== false &&
        canReuseClaudeTitle(current, settings.params.model)
      ) {
        const owner =
          getStructuredAgentSessionHost()?.deps.adapter.captureConversationTitleOwner?.(record)
        if (owner) {
          automaticTitle.retainOwnership(owner.isCurrent)
          const isCurrent = () => shouldExecute?.() ?? true
          const eligible = () =>
            getStore().getSettings().nativeChatAutoName !== false &&
            canReuseClaudeTitle(getStore().getSettings(), settings.params.model)
          if (!isCurrent()) {
            return null
          }
          let output: unknown
          try {
            output = await owner.generate(firstPrompt, () => isCurrent() && eligible())
          } catch {
            // Optional CLI control failure keeps the existing generator's recovery path.
          }
          if (!isCurrent()) {
            return null
          }
          const name = typeof output === 'string' ? sanitizeGeneratedConversationName(output) : ''
          if (name && eligible()) {
            return { name, shouldApply: eligible }
          }
          return generate(record, firstPrompt, shouldExecute, undefined)
        }
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
