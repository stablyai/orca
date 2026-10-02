import type { AgentSessionAcquisition } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { claudeProviderHandleLink } from './claude-structured-owner-identity'
import type { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import type { ClaudeJournalTranslator } from './claude-journal-translator-contract'
import {
  mintClaudeAcquisitionGeneration,
  type ClaudeSession,
  type ClaudeStructuredSessionAdapterDeps
} from './claude-structured-session-state'
import { ClaudeBackgroundTaskTracker } from './claude-background-task-tracker'
import { ClaudeChildWorkDecoder } from './claude-child-work-decoder'
import { ClaudeSlashCommandCatalog } from './claude-slash-command-catalog'
import { createClaudeSessionStartup } from './claude-structured-session-startup-state'

/** The session as published at spawn: nothing the CLI reports at init is assumed yet. */
export function createClaudeSessionPublication(input: {
  connection: ClaudeSession['connection']
  sessionId: string
  deps: Pick<
    ClaudeStructuredSessionAdapterDeps,
    'logger' | 'mintAcquisitionGeneration' | 'mintLinkId' | 'now'
  >
  providerSessionId: string
  leafUuid: string | null
  /** The launch's stored leaf: a frame seen before publication is not a completed turn. */
  turnEndLeafUuid: string | null
  fence: number
  /** The record's chain already heads this provider session: the link resumes, never creates. */
  continuesChain: boolean
  prompts: ClaudePromptRegistry
  translator: ClaudeJournalTranslator | null
  events: ClaudeSession['events']
  unbindReadingControl?: () => void
  process: AgentSessionAcquisition['process']
  options?: ReadonlyMap<string, string>
}): { acquisition: AgentSessionAcquisition; session: ClaudeSession } {
  const { deps } = input
  const acquisitionGeneration = mintClaudeAcquisitionGeneration(deps)
  const linkId = deps.mintLinkId?.()
  return {
    acquisition: {
      process: input.process,
      link: claudeProviderHandleLink({
        sessionId: input.providerSessionId,
        leafUuid: input.leafUuid,
        resumed: input.continuesChain,
        fence: input.fence,
        ...(linkId ? { linkId } : {}),
        observedAt: deps.now?.() ?? Date.now()
      }),
      acquisitionGeneration
    },
    session: {
      connection: input.connection,
      sessionId: input.sessionId,
      logger: deps.logger,
      providerSessionId: input.providerSessionId,
      leafUuid: input.leafUuid,
      turnEndLeafUuid: input.turnEndLeafUuid,
      fence: input.fence,
      acquisitionGeneration,
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
      translator: input.translator,
      events: input.events,
      ...(input.unbindReadingControl ? { unbindReadingControl: input.unbindReadingControl } : {}),
      startup: createClaudeSessionStartup()
    }
  }
}
