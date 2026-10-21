import {
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
  AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY,
  AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGE_EDIT_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGE_IMAGE_EDIT_RUNTIME_CAPABILITY,
  AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY,
  AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import { AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session-create-capabilities'
import { AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session-permission-modes-capability'
import { AGENT_SESSION_PHONE_ATTACHMENTS_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session-runtime-capabilities'

/** Structured-session features the connected host advertised; null until the status probe answers. */
export type StructuredAgentSessionHostSupport = {
  promptCancel: boolean
  questionAnswers: boolean
  /** Mid-turn sends queue as host-held drafts; an older host keeps today's immediate path. */
  queuedMessages: boolean
  /** A /compact sent while the agent works waits as a card; an older host refuses it. */
  queuedCommands: boolean
  /** Absent on older hosts: queued Edit uses the legacy composer copy there. */
  queuedMessageEdit?: boolean
  /** Save may replace a queued card's images; an older host edits its text only. */
  queuedMessageImageEdit?: boolean
  /** The host publishes every session's status on one stream. A host from before phones could
   *  read it refuses the call, which reads the same as its absence. */
  statusFeed: boolean
  /** A Stop that stopped nothing adds no row, so a repeated Stop is quiet. */
  quietRepeatedStop: boolean
  /** A send may carry the model and effort its turn runs on. */
  sendOptions: boolean
  /** A Stop naming no turn stops what the chat has in flight; an older host needs the turn. */
  conversationStop: boolean
  /** The host applies each chat's permission mode; 1.4.225–1.4.226 do without advertising it. */
  permissionModes: boolean
  /** The host keeps long output whole and serves it with `agentSession.item`. */
  itemDetail: boolean
  /** The phone may upload files into the host's chat attachment store. */
  phoneAttachments: boolean
}

export function structuredAgentSessionHostSupport(
  capabilities: readonly string[]
): StructuredAgentSessionHostSupport {
  return {
    promptCancel: capabilities.includes(AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY),
    questionAnswers: capabilities.includes(AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY),
    queuedMessages: capabilities.includes(AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY),
    queuedCommands: capabilities.includes(AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY),
    queuedMessageEdit: capabilities.includes(AGENT_SESSION_QUEUED_MESSAGE_EDIT_RUNTIME_CAPABILITY),
    queuedMessageImageEdit: capabilities.includes(
      AGENT_SESSION_QUEUED_MESSAGE_IMAGE_EDIT_RUNTIME_CAPABILITY
    ),
    statusFeed: capabilities.includes(AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY),
    quietRepeatedStop: capabilities.includes(AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY),
    sendOptions: capabilities.includes(AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY),
    conversationStop: capabilities.includes(AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY),
    permissionModes: capabilities.includes(AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY),
    itemDetail: capabilities.includes(AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY),
    phoneAttachments: capabilities.includes(AGENT_SESSION_PHONE_ATTACHMENTS_RUNTIME_CAPABILITY)
  }
}
