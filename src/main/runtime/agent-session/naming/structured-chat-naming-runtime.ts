import { ClaudeControlRequestTimeoutError } from '../../../claude/sdk-transport/claude-agent-sdk-control-requests'
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
import type { CommitMessageAgentEnvironmentResolvers } from '../../../text-generation/execution/commit-message-agent-environment'
import type { StructuredChatNamingDeps } from '../../../native-chat/conversation-naming/structured-chat-naming-types'
import type { StructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { firstStructuredChatNamingPrompt } from '../../../../shared/structured-chat-naming-eligibility'
import { firstStructuredAgentSessionPrompt } from '../../../../shared/agent-session/requests/structured-agent-session-first-prompt'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from '../../../../shared/source-control/ai/generation/commit-message-host-key'
import {
  generateConversationNameFromContext,
  resolveCommitMessageSettings as resolveTextGenerationParams
} from '../../../text-generation/commit-message-text-generation'
import { resolveGenerationTarget } from '../../../agent-hooks/first-work/first-work-generation-target'
import { deferredStructuredChatTitle } from '../../../native-chat/conversation-naming/structured-chat-title-handover'

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

function resolveChatNamingParams(
  current: Parameters<typeof resolveTextGenerationParams>[0],
  provider: Parameters<StructuredChatNamingDeps['generate']>[0]['provider'],
  recipe = resolveSourceControlActionRecipe({ settings: current, actionId: 'conversationName' })
) {
  const source = normalizeSourceControlAiSettings(current.sourceControlAi, current.commitMessageAi)
  const useChatAgent = !recipe.agentId && !recipe.agentArgs?.trim()
  return resolveTextGenerationParams(
    useChatAgent
      ? {
          ...current,
          sourceControlAi: {
            ...source,
            actions: {
              ...source.actions,
              conversationName: normalizeSourceControlActionRecipe({
                ...recipe,
                agentId: provider
              })
            }
          }
        }
      : current,
    LOCAL_COMMIT_MESSAGE_HOST_KEY,
    'conversationName',
    null
  )
}

export function structuredChatNamingDeps(
  getStore: () => {
    getSettings: () => Parameters<typeof resolveTextGenerationParams>[0] &
      AgentLaunchProfileSettings &
      ReturnType<StructuredChatNamingDeps['getSettings']>
    onSettingsChanged?: (changed: () => void) => () => void
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
    captureAutomaticTitle: (record, firstInputSubmissionKey, applicable) => {
      const current = getStore().getSettings()
      if (
        record.provider !== 'claude' ||
        record.location.wslDistro !== null ||
        current.nativeChatAutoName === false
      ) {
        return undefined
      }
      const settings = resolveChatNamingParams(current, record.provider)
      if (!settings.ok || !canReuseClaudeTitle(current, settings.params.model)) {
        return undefined
      }
      const host = getStructuredAgentSessionHost()
      const owner = host?.deps.adapter.captureConversationTitleOwner?.(record) ?? null
      return {
        owner,
        pending:
          !owner && host && firstInputSubmissionKey && applicable
            ? deferredStructuredChatTitle({
                record,
                firstInputSubmissionKey,
                host,
                currentHost: getStructuredAgentSessionHost,
                applicable,
                eligible: () => {
                  const current = getStore().getSettings()
                  const resolved = resolveChatNamingParams(current, record.provider)
                  return resolved.ok && canReuseClaudeTitle(current, resolved.params.model)
                },
                subscribeSettings: (changed) =>
                  getStore().onSettingsChanged?.(changed) ?? (() => {})
              })
            : undefined
      }
    },
    generate: async function generate(record, firstPrompt, shouldExecute, automaticTitle) {
      const titleOwner = automaticTitle?.pending
        ? await automaticTitle.pending.ready
        : automaticTitle?.owner
      if (shouldExecute?.() === false || automaticTitle?.pending?.ended()) {
        return null
      }
      // Unsupported execution contexts keep the seed regardless of native naming settings.
      if (record.location.wslDistro !== null) {
        return null
      }
      const workspace = await runtime.resolveWorkspace(record.location.workspaceId)
      if (workspace.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
        return null
      }
      const current = getStore().getSettings()
      const recipe = resolveSourceControlActionRecipe({
        settings: current,
        actionId: 'conversationName'
      })
      const useChatAgent = !recipe.agentId && !recipe.agentArgs?.trim()
      const log = { scope: 'conversation-name', sessionId: record.sessionId }
      // These save every CLI run, so a naming run would sit in the user's own history.
      if (useChatAgent && ['copilot', 'kimi', 'cursor'].includes(record.provider)) {
        return null
      }
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
      const settings = resolveChatNamingParams(current, record.provider, recipe)
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
        const owner = titleOwner
        if (owner) {
          const isCurrent = (
            current = getStructuredAgentSessionHost()?.deps.store?.getRecord(record.sessionId) ??
              record
          ) => (shouldExecute?.() ?? true) && owner.isCurrent(current)
          const eligible = () =>
            getStore().getSettings().nativeChatAutoName !== false &&
            canReuseClaudeTitle(getStore().getSettings(), settings.params.model)
          let output: unknown
          try {
            if (isCurrent()) {
              output = await owner.generate(firstPrompt, () => isCurrent() && eligible())
            }
          } catch (error) {
            if (error instanceof ClaudeControlRequestTimeoutError) {
              // A timed-out control is still in flight; its fallback keeps the original live owner.
              automaticTitle.retainOwnership?.(owner.isCurrent)
              if (!isCurrent()) {
                return null
              }
            }
          }
          const name = typeof output === 'string' ? sanitizeGeneratedConversationName(output) : ''
          if (name && isCurrent() && eligible()) {
            return { name, shouldApply: (current) => isCurrent(current) && eligible() }
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
