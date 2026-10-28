import type { AgentSessionAcquisition } from '../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { claudeProviderHandleLink } from './claude-structured-owner-identity'
import type { ClaudePromptRegistry } from '../claude-prompt-registry'
import type { ClaudeJournalTranslator } from '../claude-journal-translator-contract'
import type { ClaudeSession } from './claude-structured-session-state'
import { ClaudeBackgroundTaskTracker } from '../claude-background-task-tracker'
import { ClaudeChildWorkDecoder } from '../claude-child-work-decoder'
import { ClaudeSlashCommandCatalog } from '../claude-slash-command-catalog'

export function createClaudeSessionPublication(input: {
  connection: ClaudeSession['connection']
  providerSessionId: string
  leafUuid: string | null
  /** A frame seen before publication does not prove a completed turn. */
  turnEndLeafUuid: string | null
  fence: number
  acquisitionGeneration: string
  continuesChain: boolean
  forkedFromKey?: string
  prompts: ClaudePromptRegistry
  translator: ClaudeJournalTranslator | null
  events: ClaudeSession['events']
  unbindReadingControl?: () => void
  process: AgentSessionAcquisition['process']
  linkId?: string
  observedAt: number
  options?: ReadonlyMap<string, string>
  initialization: ClaudeSession['initialization']
}): { acquisition: AgentSessionAcquisition; session: ClaudeSession } {
  const link = claudeProviderHandleLink({
    sessionId: input.providerSessionId,
    leafUuid: input.leafUuid,
    resumed: input.continuesChain,
    ...(input.forkedFromKey ? { forkedFromKey: input.forkedFromKey } : {}),
    fence: input.fence,
    ...(input.linkId ? { linkId: input.linkId } : {}),
    observedAt: input.observedAt
  })
  return {
    acquisition: {
      process: input.process,
      acquisitionGeneration: input.acquisitionGeneration
    },
    session: {
      connection: input.connection,
      providerSessionId: input.providerSessionId,
      leafUuid: input.leafUuid,
      turnEndLeafUuid: input.turnEndLeafUuid,
      fence: input.fence,
      acquisitionGeneration: input.acquisitionGeneration,
      prompts: input.prompts,
      dispatchWaiters: [],
      retiredDispatchWaiters: [],
      replayContentFallbackBlocked: false,
      backgroundTasks: new ClaudeBackgroundTaskTracker(),
      childWork: new ClaudeChildWorkDecoder(),
      // An unread catalog is unavailable, not empty.
      commands: new ClaudeSlashCommandCatalog(),
      dispatchSequence: 0,
      optionMutationSequence: 0,
      options: new Map(input.options),
      capabilities: [],
      reportedOptions: {},
      reportedModelMutation: 0,
      confirmedOptions: new Set(),
      // Only options included at launch can skip their first control write.
      appliedInputOptions: new Map(
        [...(input.options ?? [])].filter(([key]) => key === 'model' || key === 'effort')
      ),
      launchedModel: null,
      fastModeAtStart: false,
      translator: input.translator,
      events: input.events,
      ...(input.unbindReadingControl ? { unbindReadingControl: input.unbindReadingControl } : {}),
      link,
      initialization: input.initialization
    }
  }
}
