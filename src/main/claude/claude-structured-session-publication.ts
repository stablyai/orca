import type { AgentSessionAcquisition } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeInitObservation } from './claude-structured-init-proof'
import { claudeProviderHandleLink } from './claude-structured-owner-identity'
import type { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import type { ClaudeJournalTranslator } from './claude-structured-journal-translation'
import type { ClaudeSession } from './claude-structured-session-state'
import { ClaudeBackgroundTaskTracker } from './claude-background-task-tracker'
import { ClaudeSlashCommandCatalog } from './claude-slash-command-catalog'

export function createClaudeSessionPublication(input: {
  connection: ClaudeSession['connection']
  init: ClaudeInitObservation
  initialization?: unknown
  claudeConfigDir: string
  leafUuid: string | null
  fence: number
  acquisitionGeneration: string
  resumed: boolean
  prompts: ClaudePromptRegistry
  translator: ClaudeJournalTranslator | null
  events: ClaudeSession['events']
  process: AgentSessionAcquisition['process']
  linkId?: string
  observedAt: number
  options?: ReadonlyMap<string, string>
  capabilities: readonly string[]
  /** Read from `get_settings`; `system/init` never reports an effort. */
  effort: string | null
  fastMode: boolean | null
  fastModePerSessionOptIn: boolean | null
  fastModeState?: ClaudeSession['fastModeState']
  fastModeDisabledReason?: string
}): { acquisition: AgentSessionAcquisition; session: ClaudeSession } {
  const model = input.init.model
  const effort = input.effort
  const fastMode = input.fastMode

  return {
    acquisition: {
      process: input.process,
      link: claudeProviderHandleLink({
        sessionId: input.init.providerSessionId,
        leafUuid: input.leafUuid,
        resumed: input.resumed,
        fence: input.fence,
        ...(input.linkId ? { linkId: input.linkId } : {}),
        observedAt: input.observedAt
      }),
      acquisitionGeneration: input.acquisitionGeneration
    },
    session: {
      connection: input.connection,
      providerSessionId: input.init.providerSessionId,
      claudeConfigDir: input.claudeConfigDir,
      leafUuid: input.leafUuid,
      fence: input.fence,
      acquisitionGeneration: input.acquisitionGeneration,
      prompts: input.prompts,
      dispatchWaiters: [],
      retiredDispatchWaiters: [],
      replayContentFallbackBlocked: false,
      backgroundTasks: new ClaudeBackgroundTaskTracker(),
      commands: new ClaudeSlashCommandCatalog(input.init.message, input.initialization),
      dispatchSequence: 0,
      optionMutationSequence: 0,
      options: new Map(input.options),
      capabilities: input.capabilities,
      reportedOptions: {
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(fastMode !== null ? { fastMode } : {})
      },
      ...(input.fastModeState ? { fastModeState: input.fastModeState } : {}),
      ...(input.fastModeDisabledReason
        ? { fastModeDisabledReason: input.fastModeDisabledReason }
        : {}),
      ...(input.fastModePerSessionOptIn !== null
        ? { fastModePerSessionOptIn: input.fastModePerSessionOptIn }
        : {}),
      reportedModelMutation: 0,
      confirmedOptions: new Set([
        ...(effort ? ['effort'] : []),
        ...(fastMode !== null ? ['fastMode'] : [])
      ]),
      restoreSkippedOptions: new Set(),
      translator: input.translator,
      events: input.events
    }
  }
}
