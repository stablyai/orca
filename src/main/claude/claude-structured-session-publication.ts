import type { AgentSessionAcquisition } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { claudeProviderHandleLink } from './claude-structured-owner-identity'
import type { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import type { ClaudeJournalTranslator } from './claude-journal-translator-contract'
import type { ClaudeSession } from './claude-structured-session-state'
import type { ClaudeStructuredLaunch } from './claude-structured-launch-resolution'
import { ClaudeBackgroundTaskTracker } from './claude-background-task-tracker'
import { ClaudeChildWorkDecoder } from './claude-child-work-decoder'
import { ClaudeSlashCommandCatalog } from './claude-slash-command-catalog'
import { createClaudeSessionStartup } from './claude-structured-session-startup-state'

/** The session as published at spawn: nothing the CLI reports at init is assumed yet. */
export function createClaudeSessionPublication(input: {
  connection: ClaudeSession['connection']
  /** What the launch decided: the conversation, whether the record's chain already heads it (the
   *  link resumes, never creates), whether this start copied it from the chat it forks, and the
   *  config folder the child runs under. */
  launch: Pick<
    ClaudeStructuredLaunch,
    'providerSessionId' | 'continuesChain' | 'forked' | 'claudeConfigDir'
  >
  leafUuid: string | null
  /** The launch's stored leaf: a frame seen before publication is not a completed turn. */
  turnEndLeafUuid: string | null
  fence: number
  acquisitionGeneration: string
  prompts: ClaudePromptRegistry
  translator: ClaudeJournalTranslator | null
  events: ClaudeSession['events']
  unbindReadingControl?: () => void
  process: AgentSessionAcquisition['process']
  linkId?: string
  observedAt: number
  options?: ReadonlyMap<string, string>
}): { acquisition: AgentSessionAcquisition; session: ClaudeSession } {
  return {
    acquisition: {
      process: input.process,
      link: claudeProviderHandleLink({
        sessionId: input.launch.providerSessionId,
        leafUuid: input.leafUuid,
        resumed: input.launch.continuesChain,
        // The copy holds a conversation this record's first start did not make.
        ...(input.launch.forked ? { origin: 'adopted' as const } : {}),
        fence: input.fence,
        ...(input.linkId ? { linkId: input.linkId } : {}),
        observedAt: input.observedAt
      }),
      acquisitionGeneration: input.acquisitionGeneration
    },
    session: {
      connection: input.connection,
      providerSessionId: input.launch.providerSessionId,
      claudeConfigDir: input.launch.claudeConfigDir,
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
      // Undefined until init: an unread catalog is unavailable, not empty.
      commands: new ClaudeSlashCommandCatalog(),
      dispatchSequence: 0,
      optionMutationSequence: 0,
      options: new Map(input.options),
      capabilities: [],
      reportedOptions: {},
      reportedModelMutation: 0,
      confirmedOptions: new Set(),
      restoreSkippedOptions: new Set(),
      launchedModel: null,
      fastModeAtStart: false,
      translator: input.translator,
      events: input.events,
      ...(input.unbindReadingControl ? { unbindReadingControl: input.unbindReadingControl } : {}),
      startup: createClaudeSessionStartup()
    }
  }
}
