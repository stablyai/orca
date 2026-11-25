import { MCP_SERVERS_RUNTIME_CAPABILITY } from '../../../../../src/shared/mcp-servers/mcp-servers'
import {
  AGENT_SESSION_COMMANDS_ON_REQUEST_CAPABILITY,
  AGENT_SESSION_MODEL_EFFORT_DISCOVERY_CAPABILITY,
  AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY
} from '../../../../../src/shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import {
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
  AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY,
  AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY
} from '../../../../../src/shared/agent-session/lifecycle/stopping/agent-session-stop-capabilities'
import {
  AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY,
  AGENT_SESSION_SEND_RECORDED_RUNTIME_CAPABILITY,
  AGENT_SESSION_SEND_RECORDED_ABSENCE_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGE_EDIT_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGE_REORDER_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGE_IMAGE_EDIT_RUNTIME_CAPABILITY,
  AGENT_SESSION_PHONE_ATTACHMENTS_RUNTIME_CAPABILITY,
  AGENT_SESSION_PHONE_THREAD_GOAL_RUNTIME_CAPABILITY,
  AGENT_SESSION_MCP_RUNTIME_CAPABILITY,
  AGENT_SESSION_PHONE_ACCOUNT_USAGE_RUNTIME_CAPABILITY,
  AGENT_SESSION_PHONE_REWIND_RUNTIME_CAPABILITY,
  AGENT_SESSION_PHONE_USAGE_LIMIT_CONTINUE_CANCEL_RUNTIME_CAPABILITY,
  AGENT_SESSION_SKIP_ASYNC_QUESTIONS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGE_SKILLS_EDIT_RUNTIME_CAPABILITY
} from '../../../../../src/shared/agent-session/capabilities/agent-session-runtime-capabilities'
import { AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY } from '../../../../../src/shared/agent-session/view/agent-session-attention-capabilities'
import {
  AGENT_SESSION_SEND_SELECTION_RUNTIME_CAPABILITY,
  AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY,
  AGENT_SESSION_SEND_SKILLS_RUNTIME_CAPABILITY,
  AGENT_SESSION_SEND_USAGE_LIMIT_CONTINUATION_RUNTIME_CAPABILITY,
  AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY
} from '../../../../../src/shared/agent-session/lifecycle/operations/agent-session-create-capabilities'
import {
  AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY,
  AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY
} from '../../../../../src/shared/agent-session/options/permissions/agent-session-permission-modes-capability'
import { SKILL_DISCOVER_WORKSPACE_CAPABILITY } from '../../../../../src/shared/skills/capabilities/skill-install-capability'
import { AGENT_SESSION_PHONE_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY } from '../../../../../src/shared/agent-session/lifecycle/stopping/agent-session-continue-interrupted-capability'

export type StructuredAgentSessionHostSupport = {
  commandsOnRequest?: boolean
  coherentModelCatalog?: boolean
  modelEffortDiscovery?: boolean
  promptCancel: boolean
  questionAnswers: boolean
  // Older hosts send mid-turn messages immediately instead of queueing drafts.
  queuedMessages: boolean
  // Older hosts refuse /compact while working instead of queueing it.
  queuedCommands: boolean
  /** Absent on older hosts: queued Edit uses the legacy composer copy there. */
  queuedMessageEdit?: boolean
  queuedMessageReorder?: boolean
  // Older hosts edit queued text only.
  queuedMessageImageEdit?: boolean
  queuedMessageSkillsEdit?: boolean
  // Hosts predating mobile access refuse this feed even if they implement it.
  statusFeed: boolean
  quietRepeatedStop: boolean
  /** A send may carry the model and effort its turn runs on. */
  sendSelection?: boolean
  sendOptions: boolean
  /** Older hosts refuse a send body carrying picked skill paths. */
  sendSkills?: boolean
  /** Older hosts need the workspace folder to scan skills, which the phone does not know. */
  discoverWorkspaceSkills?: boolean
  /** A Stop naming no turn stops what the chat has in flight; an older host needs the turn. */
  conversationStop: boolean
  /** The host applies each chat's permission mode; 1.4.225–1.4.226 do without advertising it. */
  permissionModes: boolean
  permissionOwn?: boolean
  itemDetail: boolean
  /** The host says whether it recorded a send; older hosts answer only through loaded pages. */
  sendRecorded?: boolean | 'confirmed-absence'
  phoneAttachments: boolean
  /** Older hosts lack Continue on an Orca-stopped turn or refuse it from a phone; the phone sends an ordinary message there. */
  continueInterrupted?: boolean
  /** Older hosts report goals but refuse the phone's goal changes. */
  phoneThreadGoal?: boolean
  /** The host answers `agentSession.mcp` for the `/mcp` tray. */
  mcp?: boolean
  /** The host answers a phone's `agentSession.accountUsage` for `/usage`. */
  phoneAccountUsage?: boolean
  /** Older hosts advertise rewind but refuse it from a phone. */
  phoneRewind?: boolean
  /** The host continues a usage-limited chat at its reset and publishes that on the status feed. */
  usageLimitAutoContinue: boolean
  /** The host takes "Don't continue" from a phone. */
  usageLimitContinueCancel: boolean
  /** A send may name the usage-limit cut it continues. */
  sendUsageLimitContinuation: boolean
  /** The host saves Skip on an async question card for every device. */
  skipAsyncQuestions?: boolean
  /** The host keeps its own MCP server list, which its chats' `/mcp` tray links to. */
  mcpServers?: boolean
}

export function structuredAgentSessionHostSupport(
  capabilities: readonly string[]
): StructuredAgentSessionHostSupport {
  const supports = (capability: string): boolean => capabilities.includes(capability)
  return {
    commandsOnRequest: supports(AGENT_SESSION_COMMANDS_ON_REQUEST_CAPABILITY),
    coherentModelCatalog: supports(AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY),
    modelEffortDiscovery: supports(AGENT_SESSION_MODEL_EFFORT_DISCOVERY_CAPABILITY),
    promptCancel: supports(AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY),
    questionAnswers: supports(AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY),
    queuedMessages: supports(AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY),
    queuedCommands: supports(AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY),
    queuedMessageEdit: supports(AGENT_SESSION_QUEUED_MESSAGE_EDIT_RUNTIME_CAPABILITY),
    queuedMessageSkillsEdit: supports(AGENT_SESSION_QUEUED_MESSAGE_SKILLS_EDIT_RUNTIME_CAPABILITY),
    queuedMessageReorder: supports(AGENT_SESSION_QUEUED_MESSAGE_REORDER_RUNTIME_CAPABILITY),
    queuedMessageImageEdit: supports(AGENT_SESSION_QUEUED_MESSAGE_IMAGE_EDIT_RUNTIME_CAPABILITY),
    statusFeed: supports(AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY),
    quietRepeatedStop: supports(AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY),
    sendSelection: supports(AGENT_SESSION_SEND_SELECTION_RUNTIME_CAPABILITY),
    sendOptions: supports(AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY),
    sendSkills: supports(AGENT_SESSION_SEND_SKILLS_RUNTIME_CAPABILITY),
    discoverWorkspaceSkills: supports(SKILL_DISCOVER_WORKSPACE_CAPABILITY),
    conversationStop: supports(AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY),
    permissionOwn: supports(AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY),
    permissionModes: supports(AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY),
    itemDetail: supports(AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY),
    sendRecorded: supports(AGENT_SESSION_SEND_RECORDED_ABSENCE_RUNTIME_CAPABILITY)
      ? 'confirmed-absence'
      : supports(AGENT_SESSION_SEND_RECORDED_RUNTIME_CAPABILITY),
    phoneAttachments: supports(AGENT_SESSION_PHONE_ATTACHMENTS_RUNTIME_CAPABILITY),
    continueInterrupted: supports(AGENT_SESSION_PHONE_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY),
    phoneThreadGoal: supports(AGENT_SESSION_PHONE_THREAD_GOAL_RUNTIME_CAPABILITY),
    mcp: supports(AGENT_SESSION_MCP_RUNTIME_CAPABILITY),
    phoneAccountUsage: supports(AGENT_SESSION_PHONE_ACCOUNT_USAGE_RUNTIME_CAPABILITY),
    phoneRewind: supports(AGENT_SESSION_PHONE_REWIND_RUNTIME_CAPABILITY),
    usageLimitAutoContinue: supports(AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY),
    usageLimitContinueCancel: supports(
      AGENT_SESSION_PHONE_USAGE_LIMIT_CONTINUE_CANCEL_RUNTIME_CAPABILITY
    ),
    sendUsageLimitContinuation: supports(
      AGENT_SESSION_SEND_USAGE_LIMIT_CONTINUATION_RUNTIME_CAPABILITY
    ),
    skipAsyncQuestions: supports(AGENT_SESSION_SKIP_ASYNC_QUESTIONS_RUNTIME_CAPABILITY),
    mcpServers: supports(MCP_SERVERS_RUNTIME_CAPABILITY)
  }
}
