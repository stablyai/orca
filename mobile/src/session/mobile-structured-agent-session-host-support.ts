import {
  AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY,
  AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY,
  AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY,
  AGENT_SESSION_TARGETED_STOP_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'

/** Structured-session features the connected host advertised; null until the status probe answers. */
export type StructuredAgentSessionHostSupport = {
  promptCancel: boolean
  questionAnswers: boolean
  /** Mid-turn sends queue as host-held drafts; an older host keeps today's immediate path. */
  queuedMessages: boolean
  /** A /compact sent while the agent works waits as a card; an older host refuses it. */
  queuedCommands: boolean
  /** The host publishes every session's status on one stream. A host from before phones could
   *  read it refuses the call, which reads the same as its absence. */
  statusFeed: boolean
  /** A Stop that stopped nothing adds no row, so a repeated Stop is quiet. */
  quietRepeatedStop: boolean
  targetedStop?: boolean
}

export function structuredAgentSessionHostSupport(
  capabilities: readonly string[]
): StructuredAgentSessionHostSupport {
  return {
    promptCancel: capabilities.includes(AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY),
    questionAnswers: capabilities.includes(AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY),
    queuedMessages: capabilities.includes(AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY),
    queuedCommands: capabilities.includes(AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY),
    statusFeed: capabilities.includes(AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY),
    quietRepeatedStop: capabilities.includes(AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY),
    targetedStop: capabilities.includes(AGENT_SESSION_TARGETED_STOP_RUNTIME_CAPABILITY)
  }
}
