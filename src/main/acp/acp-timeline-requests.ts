import { z } from 'zod'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpDialect, AcpRequestPresentation } from './acp-dialects/acp-dialect'
import type { AcpToolTimeline } from './acp-tool-timeline'
import { AcpRpcError } from './acp-errors'
import { readAcpPermissionRequest } from './acp-permission-requests'

export const pendingAcpResolution = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
} as const

export function acpPermissionPresentation(
  params: unknown,
  dialect: AcpDialect
): AcpRequestPresentation {
  // The runtime already read this request and reported any field it dropped.
  const request = readAcpPermissionRequest(params, () => {})
  if (!request) {
    throw new AcpRpcError(-32602, 'Invalid ACP permission request')
  }
  const { toolCall, options } = request
  return {
    body: {
      kind: 'approval',
      title: toolCall.title ?? 'Permission requested',
      detail: null,
      options: options.map((option) => ({
        id: option.optionId,
        label: dialect.permissionOptionLabel?.(option) ?? option.name
      })),
      resolution: pendingAcpResolution
    },
    reply: (response) => {
      if (response === null) {
        return { outcome: { outcome: 'cancelled' } }
      }
      if (
        response.kind !== 'option' ||
        !options.some((option) => option.optionId === response.optionId)
      ) {
        throw new AcpRpcError(-32602, 'Permission answer must select an offered option')
      }
      return { outcome: { outcome: 'selected', optionId: response.optionId } }
    }
  }
}

const requestSessionSchema = z.object({ sessionId: z.string() })
const UNADVERTISED_CLIENT_METHOD = /^(?:fs|terminal)\//
const requestToolSchema = z.object({
  toolCallId: z.string().optional(),
  toolCall: z.object({ toolCallId: z.string() }).optional()
})

export function translateAcpRequest(
  method: string,
  params: unknown,
  id: string | number,
  options: {
    sessionId: string
    dialect: AcpDialect
    tools: AcpToolTimeline
  }
): {
  events: ProviderTimelineEvent[]
  presentation?: AcpRequestPresentation
  /** Answered at once: nobody is asked. */
  settled?: { reply: unknown }
} {
  const session = requestSessionSchema.safeParse(params)
  if (!session.success || session.data.sessionId !== options.sessionId) {
    throw new AcpRpcError(-32602, 'ACP request belongs to an unknown session')
  }
  const tool = requestToolSchema.safeParse(params)
  const callId = tool.success ? (tool.data.toolCall?.toolCallId ?? tool.data.toolCallId) : undefined
  const turn = callId ? options.tools.turn(callId) : undefined
  const join = { thread: options.sessionId, ...(turn === undefined ? {} : { turn }) }
  const settlement =
    method === 'session/request_permission'
      ? undefined
      : options.dialect.settleRequest?.(method, params)
  if (settlement) {
    const plan = settlement.plan
    return {
      settled: { reply: settlement.reply },
      events:
        plan === undefined
          ? []
          : [
              {
                type: 'item.update',
                item: `${method}:${JSON.stringify(id)}`,
                body: {
                  kind: 'status',
                  presentation: 'plan-document',
                  text: boundInlineText(plan, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
                },
                join
              }
            ]
    }
  }
  const presentation =
    method === 'session/request_permission'
      ? acpPermissionPresentation(params, options.dialect)
      : options.dialect.request?.(method, params)
  if (!presentation) {
    // A file system or terminal call Orca never advertised is the agent's own misstep (OpenCode 1.x
    // repeats each approved edit as a file write it already made): refused, with no row.
    if (UNADVERTISED_CLIENT_METHOD.test(method)) {
      return { events: [] }
    }
    return {
      events: [{ type: 'provider.frame', frameKind: `request:${method}`, payload: params, join }]
    }
  }
  return {
    presentation,
    events: [
      {
        type: 'request.open',
        request: `${method}:${JSON.stringify(id)}`,
        body: presentation.body,
        join
      }
    ]
  }
}
