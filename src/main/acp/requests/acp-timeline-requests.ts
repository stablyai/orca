import { z } from 'zod'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import {
  pendingAcpResolution,
  type AcpDialect,
  type AcpRequestPresentation
} from '../acp-dialects/acp-dialect'
import type { AcpToolTimeline } from '../timeline/acp-tool-timeline'
import { AcpRpcError } from '../transport/acp-errors'
import { ACP_FORM_ELICITATION_METHOD, acpFormElicitationPresentation } from './acp-form-elicitation'
import { readAcpPermissionRequest } from '../protocol/acp-permission-requests'
import { isAgentJournalPromptIntent } from '../../../shared/agent-session/journal/agent-session-journal-types'

export function acpPermissionPresentation(
  params: unknown,
  description?: string
): AcpRequestPresentation {
  // Runtime parsing already reported dropped fields.
  const request = readAcpPermissionRequest(params, () => {})
  if (!request) {
    throw new AcpRpcError(-32602, 'Invalid ACP permission request')
  }
  const { toolCall, options } = request
  return {
    body: {
      kind: 'approval',
      title: toolCall.title ?? 'Permission requested',
      ...(description ? { description } : {}),
      detail: null,
      options: options.map((option) => ({
        id: option.optionId,
        label: option.name,
        ...(isAgentJournalPromptIntent(option.kind) ? { intent: option.kind } : {})
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
  settled?: { reply: unknown }
} {
  const session = requestSessionSchema.safeParse(params)
  const sessionless = options.dialect.sessionlessRequests?.includes(method) && !session.success
  if (!sessionless && (!session.success || session.data.sessionId !== options.sessionId)) {
    throw new AcpRpcError(-32602, 'ACP request belongs to an unknown session')
  }
  const tool = requestToolSchema.safeParse(params)
  const callId = tool.success ? (tool.data.toolCall?.toolCallId ?? tool.data.toolCallId) : undefined
  const join = { thread: options.sessionId, ...(callId ? options.tools.join(callId) : {}) }
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
                  text: plan
                },
                join
              }
            ]
    }
  }
  const presentation =
    options.dialect.request?.(method, params) ??
    (method === 'session/request_permission' ? acpPermissionPresentation(params) : undefined) ??
    (method === ACP_FORM_ELICITATION_METHOD ? acpFormElicitationPresentation(params) : undefined)
  if (!presentation) {
    // OpenCode 1.x repeats completed writes through unadvertised client methods; omit their rows.
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
        join,
        // The live exchange ends only by answer or withdrawal, not with the turn that shows it.
        outlivesTurn: true
      }
    ]
  }
}
