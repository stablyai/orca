import type { AcpAgentError } from '../transport/acp-errors'
import { readAcpPermissionRequest } from '../protocol/acp-permission-requests'
import { acpPermissionPresentation } from '../requests/acp-timeline-requests'
import type { AcpDialect, AcpRequestPresentation, AcpTurnEnding } from './acp-dialect'

const APPROVAL_NAME = /^Requesting (?:approval|permission) to (.+)$/iu
const REQUEST_MAX_CHARS = 512

// Vibe sends permission requests as session/request_permission requests.
function approvalRequest(method: string, params: unknown): AcpRequestPresentation | undefined {
  const request =
    method === 'session/request_permission' ? readAcpPermissionRequest(params, () => {}) : null
  const name = request?.toolCall.content
    ?.map((block) =>
      block.type === 'content' && block.content.type === 'text'
        ? APPROVAL_NAME.exec(block.content.text)?.[1]?.trim()
        : undefined
    )
    .find(Boolean)
  return name ? acpPermissionPresentation(params, name.slice(0, REQUEST_MAX_CHARS)) : undefined
}

function promptFailure(
  error: AcpAgentError,
  _at: number
): Pick<AcpTurnEnding, 'stopReason' | 'usageLimit' | 'providerFailure'> | undefined {
  // A user stop during a pending approval surfaces as a cancel error; report it as a cancelled
  // turn, not an error. Match both spellings ("cancelled"/"canceled").
  if (error.message && /cancel/i.test(error.message)) {
    return { stopReason: 'cancelled' }
  }
  return undefined
}

export const VIBE_ACP_DIALECT: AcpDialect = {
  clientCapabilities: { elicitation: { form: {} } },
  request: approvalRequest,
  promptFailure
}
