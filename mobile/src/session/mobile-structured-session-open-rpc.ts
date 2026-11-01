import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import type { RpcMethodName } from '../transport/rpc-params-contract'

function openingRead<Method extends RpcMethodName, Schema extends z.ZodType>(
  method: Method,
  schema: Schema
) {
  return bindDeferredRpcOperation(
    defineRpcOperation({
      name: `chat.open:${method}`,
      method,
      acceptance: 'require-result-or-throw-message',
      barrier: 'after-caller-barrier',
      read: rpcResultVariant('chat-open', schema)
    })
  )
}
export const structuredOpenLocation = openingRead(
  'orchestration.partyLocation',
  z.object({
    location: z
      .discriminatedUnion('kind', [
        z.object({
          kind: z.literal('chat'),
          sessionId: z.string().min(1),
          worktreeId: z.string().min(1)
        }),
        z.object({ kind: z.literal('terminal'), handle: z.string().min(1) })
      ])
      .nullable(),
    lost: z.enum(['chat', 'terminal']).optional()
  })
)
export const structuredOpenReveal = openingRead(
  'agentSession.reveal',
  z.union([
    z.object({
      ok: z.literal(true),
      sessionId: z.string().min(1),
      workspaceId: z.string().min(1),
      agent: z.string().min(1),
      readable: z.boolean()
    }),
    z.object({ ok: z.literal(false), refusal: z.object({ code: z.string() }) })
  ])
)
export const structuredOpenTabs = openingRead(
  'session.tabs.list',
  z.object({
    tabs: z.array(
      z.looseObject({
        type: z.string(),
        id: z.string().min(1),
        sessionId: z.string().optional(),
        agent: z.string().optional()
      })
    )
  })
)
