import type { RequestPermissionRequest } from '../generated/acp-protocol.generated'
import { readAcpPermissionRequest } from '../protocol/acp-permission-requests'
import { acpPermissionPresentation } from '../requests/acp-timeline-requests'
import type { AcpRequestPresentation } from './acp-dialect'

const PRESENTATION_MAX_CHARS = 512

/** Shared skeleton for a dialect's `request` presentation of session/request_permission: parse the
 *  request once, let the dialect extract the description, cap it, and build the presentation. */
export function approvalRequestPresentation(
  method: string,
  params: unknown,
  extract: (request: RequestPermissionRequest) => string | undefined
): AcpRequestPresentation | undefined {
  if (method !== 'session/request_permission') {
    return undefined
  }
  const request = readAcpPermissionRequest(params, () => {})
  const description = request ? extract(request)?.trim() : undefined
  return description
    ? acpPermissionPresentation(params, description.slice(0, PRESENTATION_MAX_CHARS))
    : undefined
}

/** The first text block of the tool call that `pattern` captures a description from. */
export function approvalNameFromToolCall(
  pattern: RegExp,
  request: RequestPermissionRequest
): string | undefined {
  return request.toolCall.content
    ?.map((block) =>
      block.type === 'content' && block.content.type === 'text'
        ? pattern.exec(block.content.text)?.[1]
        : undefined
    )
    .find(Boolean)
}
