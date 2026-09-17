import type { AgentSessionAcquisition } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeInitObservation } from './claude-structured-init-proof'
import { claudeProviderHandleLink } from './claude-structured-owner-identity'
import type { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import type { ClaudeJournalTranslator } from './claude-structured-journal-translation'
import type { ClaudeSession } from './claude-structured-session-state'
import { ClaudeBackgroundTaskTracker } from './claude-background-task-tracker'
import { ClaudeSlashCommandCatalog } from './claude-slash-command-catalog'
import { readStructuredAgentSessionPermissionMode } from '../../shared/structured-agent-session-permission-mode'

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
  permissionModeRestoreValue?: ClaudeSession['basePermissionMode']
  launchPermissionMode?: ClaudeSession['basePermissionMode']
  settingsPermissionMode?: ClaudeSession['basePermissionMode']
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
  const persistedPermissionMode = readStructuredAgentSessionPermissionMode(
    input.options?.get('permissionMode')
  )
  const reportedPermissionMode =
    input.settingsPermissionMode ?? input.init.permissionMode ?? undefined
  // The durable baseline wins; otherwise capture the provider's state or its accepted launch mode.
  const basePermissionMode =
    input.permissionModeRestoreValue ??
    (persistedPermissionMode && persistedPermissionMode !== 'plan'
      ? persistedPermissionMode
      : reportedPermissionMode && reportedPermissionMode !== 'plan'
        ? reportedPermissionMode
        : input.launchPermissionMode && input.launchPermissionMode !== 'plan'
          ? input.launchPermissionMode
          : undefined)
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
      permissionModeMutationSequence: 0,
      reportedPermissionModeMutation: 0,
      options: new Map(input.options),
      capabilities: input.capabilities,
      reportedOptions: {
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(fastMode !== null ? { fastMode } : {}),
        ...(reportedPermissionMode ? { permissionMode: reportedPermissionMode } : {})
      },
      ...(basePermissionMode ? { basePermissionMode } : {}),
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
        ...(fastMode !== null ? ['fastMode'] : []),
        ...(basePermissionMode && reportedPermissionMode === basePermissionMode
          ? ['permissionMode']
          : [])
      ]),
      restoreSkippedOptions: new Set(),
      translator: input.translator,
      events: input.events
    }
  }
}
