import { z } from 'zod'
import type { AcpRequestContext } from './acp-json-rpc-peer'
import {
  PermissionOptionSchema,
  RequestPermissionRequestSchema,
  RequestPermissionResponseSchema,
  ToolCallUpdateSchema,
  type RequestPermissionRequest,
  type RequestPermissionResponse
} from './generated/acp-protocol.generated'

export type AcpPermissionHandler = (
  request: RequestPermissionRequest,
  context: AcpRequestContext
) => RequestPermissionResponse | Promise<RequestPermissionResponse>

const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
const routingSchema = z.looseObject({
  sessionId: z.string(),
  toolCall: z.looseObject({ toolCallId: z.string() }),
  options: z.array(z.unknown())
})
const optionRoutingSchema = z.looseObject({ optionId: z.string() })

// Keeps every field the schema does not know or can read; drops (and names) the unreadable ones.
function readableFields(
  knownFields: Record<string, z.ZodType>,
  value: Record<string, unknown>,
  path: string,
  dropped: string[]
): Record<string, unknown> {
  const kept: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value)) {
    if (!Object.hasOwn(knownFields, key) || knownFields[key].safeParse(field).success) {
      kept[key] = field
    } else {
      dropped.push(`${path}${key}`)
    }
  }
  return kept
}

/** Validates only what answering needs (session, tool call id, options with ids); null if unusable. */
export function readAcpPermissionRequest(
  params: unknown,
  diagnose: (message: string) => void
): RequestPermissionRequest | null {
  const strict = RequestPermissionRequestSchema.safeParse(params)
  if (strict.success) {
    return strict.data
  }
  const routing = routingSchema.safeParse(params)
  if (!routing.success) {
    return null
  }
  const { toolCall, options: offered, ...rest } = routing.data
  const dropped: string[] = []
  const options = offered.flatMap((option, index) => {
    const ids = optionRoutingSchema.safeParse(option)
    if (!ids.success) {
      dropped.push(`options.${index}`)
      return []
    }
    if (typeof ids.data.name !== 'string') {
      dropped.push(`options.${index}.name`)
    }
    const named = {
      ...ids.data,
      name: typeof ids.data.name === 'string' ? ids.data.name : ids.data.optionId
    }
    const parsed = PermissionOptionSchema.safeParse(named)
    if (!parsed.success) {
      dropped.push(`options.${index}`)
      return []
    }
    return [parsed.data]
  })
  if (options.length === 0) {
    return null
  }
  const request = RequestPermissionRequestSchema.safeParse({
    ...readableFields(RequestPermissionRequestSchema.shape, rest, '', dropped),
    toolCall: readableFields(ToolCallUpdateSchema.shape, toolCall, 'toolCall.', dropped),
    options
  })
  if (!request.success) {
    return null
  }
  if (dropped.length > 0) {
    diagnose(`Delivered ACP permission request without unreadable fields: ${dropped.join(', ')}`)
  }
  return request.data
}

/** Asks the caller; any answer Orca cannot send (a throw, a bad reply, an unoffered option) is `cancelled`. */
export function answerAcpPermission(
  request: RequestPermissionRequest,
  context: AcpRequestContext,
  handler: AcpPermissionHandler | undefined,
  diagnose: (message: string) => void
): Promise<RequestPermissionResponse> {
  if (!handler || context.signal.aborted) {
    return Promise.resolve(cancelled)
  }
  return new Promise((resolve) => {
    const controller = new AbortController()
    let settled = false
    const finish = (response: RequestPermissionResponse, problem?: string): void => {
      if (settled) {
        return
      }
      settled = true
      context.signal.removeEventListener('abort', onAbort)
      controller.abort()
      if (problem) {
        diagnose(`Answered ACP permission request cancelled: ${problem}`)
      }
      resolve(response)
    }
    const onAbort = (): void => finish(cancelled)
    context.signal.addEventListener('abort', onAbort, { once: true })
    void Promise.resolve()
      .then(() => handler(request, { id: context.id, signal: controller.signal }))
      .then(
        (response) => {
          const parsed = RequestPermissionResponseSchema.safeParse(response)
          if (!parsed.success) {
            finish(cancelled, 'invalid handler response')
            return
          }
          const outcome = parsed.data.outcome
          if (
            outcome.outcome === 'selected' &&
            !request.options.some((option) => option.optionId === outcome.optionId)
          ) {
            finish(cancelled, 'handler selected an unavailable option')
            return
          }
          finish(parsed.data)
        },
        (error) => finish(cancelled, `handler failed: ${String(error)}`)
      )
  })
}
