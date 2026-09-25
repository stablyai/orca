import type {
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'

export type AgentSessionComposerMetadata = {
  sessionId: string
  commands?: AgentSessionSlashCommand[] | null
  promptSuggestion?: string | null
}

export type AgentSessionComposerMetadataHooks = {
  readCommands?: (sessionId: string) => AgentSessionSlashCommand[] | undefined
  readPromptSuggestion?: (sessionId: string) => string | null
}

export function composerMetadataChanged(
  subscriber: AgentSessionComposerMetadata,
  hooks: AgentSessionComposerMetadataHooks
): boolean {
  return (
    (hooks.readCommands !== undefined &&
      (hooks.readCommands(subscriber.sessionId) ?? null) !== subscriber.commands) ||
    (hooks.readPromptSuggestion !== undefined &&
      hooks.readPromptSuggestion(subscriber.sessionId) !== subscriber.promptSuggestion)
  )
}

export function withComposerMetadata(
  subscriber: AgentSessionComposerMetadata,
  event: AgentSessionSubscribeEvent,
  hooks: AgentSessionComposerMetadataHooks
): AgentSessionSubscribeEvent {
  if (event.type === 'end') {
    return event
  }
  const commands = hooks.readCommands?.(subscriber.sessionId) ?? null
  const promptSuggestion = hooks.readPromptSuggestion?.(subscriber.sessionId) ?? null
  const includeCommands =
    hooks.readCommands !== undefined && (event.type !== 'batch' || commands !== subscriber.commands)
  const includeSuggestion =
    hooks.readPromptSuggestion !== undefined &&
    (event.type !== 'batch' || promptSuggestion !== subscriber.promptSuggestion)
  subscriber.commands = commands
  subscriber.promptSuggestion = promptSuggestion
  return {
    ...event,
    ...(includeCommands ? { commands } : {}),
    ...(includeSuggestion ? { promptSuggestion } : {})
  }
}
