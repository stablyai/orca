import type { AgentSessionAcquisition } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { readClaudeFrameString, type ClaudeInitObservation } from './claude-structured-init-proof'
import { claudeProviderHandleLink } from './claude-structured-owner-identity'
import type { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import type { ClaudeJournalTranslator } from './claude-structured-journal-translation'
import type { ClaudeSession } from './claude-structured-session-state'

export function createClaudeSessionPublication(input: {
  connection: ClaudeSession['connection']
  init: ClaudeInitObservation
  leafUuid: string | null
  fence: number
  resumed: boolean
  prompts: ClaudePromptRegistry
  translator: ClaudeJournalTranslator | null
  events: ClaudeSession['events']
  process: AgentSessionAcquisition['process']
  linkId?: string
  observedAt: number
  options?: ReadonlyMap<string, string>
}): { acquisition: AgentSessionAcquisition; session: ClaudeSession } {
  const model = readClaudeFrameString(input.init.message, 'model')
  const effort = readClaudeFrameString(input.init.message, 'effortLevel')
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
      })
    },
    session: {
      connection: input.connection,
      providerSessionId: input.init.providerSessionId,
      leafUuid: input.leafUuid,
      fence: input.fence,
      prompts: input.prompts,
      dispatchWaiters: [],
      options: new Map(input.options),
      reportedOptions: {
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {})
      },
      translator: input.translator,
      events: input.events
    }
  }
}
