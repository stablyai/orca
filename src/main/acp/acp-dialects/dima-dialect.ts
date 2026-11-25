import { z } from 'zod'
import { readAcpPermissionRequest } from '../protocol/acp-permission-requests'
import { acpPermissionPresentation } from '../requests/acp-timeline-requests'
import type { AcpDialect, AcpRequestPresentation } from './acp-dialect'

const approvalInputSchema = z.looseObject({
  command: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional()
})
const ACTION_MAX_CHARS = 512

// An approval is titled with the preset's reason; what it would run or touch is only in its input.
function approvalRequest(method: string, params: unknown): AcpRequestPresentation | undefined {
  const request =
    method === 'session/request_permission' ? readAcpPermissionRequest(params, () => {}) : null
  const input = approvalInputSchema.safeParse(request?.toolCall.rawInput).data
  const action = input?.command ?? input?.path ?? input?.url
  return action ? acpPermissionPresentation(params, action.slice(0, ACTION_MAX_CHARS)) : undefined
}

export const DIMA_ACP_DIALECT: AcpDialect = {
  request: approvalRequest
}
