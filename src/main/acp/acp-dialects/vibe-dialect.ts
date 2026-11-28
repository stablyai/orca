import type { AcpAgentError } from '../transport/acp-errors'
import { approvalNameFromToolCall, approvalRequestPresentation } from './acp-approval-presentation'
import type { AcpDialect, AcpRequestPresentation, AcpTurnEnding } from './acp-dialect'

const APPROVAL_NAME = /^Requesting (?:approval|permission) to (.+)$/iu

// vibe-acp 3.1.x sends no content on the permission tool call, so fall back to its title or the
// tool name it puts in toolCallId; the action line is used when a build does send content.
const approvalRequest = (method: string, params: unknown): AcpRequestPresentation | undefined =>
  approvalRequestPresentation(
    method,
    params,
    (request) =>
      approvalNameFromToolCall(APPROVAL_NAME, request) ??
      request.toolCall.title ??
      request.toolCall.toolCallId
  )

// JSON-RPC's reserved cancel code, or the user-stop wording, marks a cancelled turn. A provider
// failure that merely mentions "cancel" stays an error.
const CANCELLED_BY_USER = /cancell?ed by (?:the )?user/i
const CANCELLED_ERROR_CODE = -32800

function promptFailure(
  error: AcpAgentError,
  _at: number
): Pick<AcpTurnEnding, 'stopReason' | 'usageLimit' | 'providerFailure'> | undefined {
  // A user stop during a pending approval surfaces as a cancel error; report it as a cancelled
  // turn, not an error. Match both spellings ("cancelled"/"canceled").
  if (
    error.code === CANCELLED_ERROR_CODE ||
    (error.message && CANCELLED_BY_USER.test(error.message))
  ) {
    return { stopReason: 'cancelled' }
  }
  return undefined
}

export const VIBE_ACP_DIALECT: AcpDialect = {
  clientCapabilities: { elicitation: { form: {} } },
  request: approvalRequest,
  promptFailure
}
