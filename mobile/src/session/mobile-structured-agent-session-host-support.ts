import { AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY } from '../../../src/shared/structured-agent-session-surface-capabilities'
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

export type StructuredAgentSessionHostSupport = {
  coherentModelCatalog?: boolean
  promptCancel: boolean
  questionAnswers: boolean
  // Older hosts send mid-turn messages immediately instead of queueing drafts.
  queuedMessages: boolean
  // Older hosts refuse /compact while working instead of queueing it.
  queuedCommands: boolean
  /** Absent on older hosts: queued Edit uses the legacy composer copy there. */
  queuedMessageEdit?: boolean
  // Older hosts edit queued text only.
  queuedMessageImageEdit?: boolean
  // Hosts predating mobile access refuse this feed even if they implement it.
  statusFeed: boolean
  quietRepeatedStop: boolean
  sendOptions: boolean
  /** A Stop naming no turn stops what the chat has in flight; an older host needs the turn. */
  conversationStop: boolean
  /** The host applies each chat's permission mode; 1.4.225–1.4.226 do without advertising it. */
  permissionModes: boolean
  itemDetail: boolean
  phoneAttachments: boolean
}

export function structuredAgentSessionHostSupport(
  capabilities: readonly string[]
): StructuredAgentSessionHostSupport {
  return {
    coherentModelCatalog: capabilities.includes(AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY),
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
