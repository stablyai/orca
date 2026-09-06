import {
  AGENT_MODEL_MAX_LENGTH,
  AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH,
  AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_STATUS_TOOL_NAME_MAX_LENGTH,
  AGENT_TYPE_MAX_LENGTH,
  AGENT_WORKING_MODES
} from '../../../src/shared/agent-status-types'
import type { MobileWebSessionTab } from '../../../src/shared/mobile-web/bridge-operation-contract'
import { boundedOptionalText, safeNonnegativeInteger } from './mobile-web-session-value-bounds'

type ProjectedAgentStatus = Extract<MobileWebSessionTab, { type: 'terminal' }>['agentStatus']

/** Projects the host's live agent status onto the page's terminal tab. Every field the page's chat
 *  reads must appear here: an omission is invisible on the native app, which reads `session.tabs`
 *  directly, and only degrades the hosted page. */
export function mobileWebSessionAgentStatus(value: unknown): ProjectedAgentStatus {
  if (!isRecord(value) || !isAgentState(value.state)) {
    return undefined
  }
  const stateStartedAt = safeNonnegativeInteger(value.stateStartedAt)
  const agentType = boundedOptionalText(value.agentType, AGENT_TYPE_MAX_LENGTH)
  const model = boundedOptionalText(value.model, AGENT_MODEL_MAX_LENGTH)
  const toolName = boundedOptionalText(value.toolName, AGENT_STATUS_TOOL_NAME_MAX_LENGTH)
  const toolInput = boundedOptionalText(value.toolInput, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
  const interactivePrompt = boundedOptionalText(
    value.interactivePrompt,
    AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH
  )
  const lastAssistantMessage = boundedOptionalText(
    value.lastAssistantMessage,
    AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH
  )
  return {
    state: value.state,
    ...(stateStartedAt === undefined ? {} : { stateStartedAt }),
    ...(agentType ? { agentType } : {}),
    ...(model ? { model } : {}),
    ...(toolName ? { toolName } : {}),
    ...(toolInput ? { toolInput } : {}),
    ...(interactivePrompt ? { interactivePrompt } : {}),
    ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
    ...(typeof value.lastAssistantMessageIsToolOutput === 'boolean'
      ? { lastAssistantMessageIsToolOutput: value.lastAssistantMessageIsToolOutput }
      : {}),
    ...(isAgentWorkingMode(value.workingMode) ? { workingMode: value.workingMode } : {}),
    ...(typeof value.interrupted === 'boolean' ? { interrupted: value.interrupted } : {})
  }
}

function isAgentState(value: unknown): value is 'working' | 'blocked' | 'waiting' | 'done' {
  return value === 'working' || value === 'blocked' || value === 'waiting' || value === 'done'
}

function isAgentWorkingMode(value: unknown): value is (typeof AGENT_WORKING_MODES)[number] {
  return AGENT_WORKING_MODES.includes(value as (typeof AGENT_WORKING_MODES)[number])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
