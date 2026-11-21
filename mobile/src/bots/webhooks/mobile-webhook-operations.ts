// The Webhooks page's reads and owner actions, all on the phone's bot allowlist. Copy URL reuses the card's reveal.
import * as z from 'zod'
import {
  WEBHOOK_ADAPTERS,
  WEBHOOK_CALL_STATES,
  WEBHOOK_WHERE_OPS
} from '../../../../src/shared/connector-webhook-contract'
import type { RpcMethodName } from '../../../../src/shared/rpc-contract/rpc-params-catalog.generated'
import { salvagingArray } from '../../../../src/shared/validation/zod-salvage'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'

const ResultsToSchema = z.union([
  z.enum(['chat', 'none', 'thread']),
  z.looseObject({ channel: z.string(), label: z.string().optional() }),
  z.looseObject({ linearIssue: z.string(), label: z.string().optional() })
])

const FiltersSchema = z.looseObject({
  where: z
    .array(
      z.looseObject({
        path: z.string(),
        op: z.enum(WEBHOOK_WHERE_OPS),
        values: z.array(z.string()).optional()
      })
    )
    .optional(),
  textContains: z.string().optional(),
  subject: z.string().optional(),
  pick: z.array(z.string()).optional()
})

const WebhookSummarySchema = z.looseObject({
  hookId: z.string(),
  botId: z.string(),
  state: z.enum(['pending', 'live', 'paused', 'orphaned']),
  url: z.string(),
  adapter: z.enum(WEBHOOK_ADAPTERS).nullable(),
  lastCall: z.looseObject({ at: z.number(), signatureValid: z.boolean() }).nullable(),
  host: z.enum(['online', 'offline']),
  automationName: z.string(),
  deletesAutomation: z.boolean().optional(),
  resultsTo: ResultsToSchema,
  filters: FiltersSchema,
  pendingCalls: z.number(),
  keyGeneration: z.number()
})

export type PhoneWebhook = z.infer<typeof WebhookSummarySchema>

const WebhookCallRowSchema = z.union([
  z.looseObject({
    kind: z.literal('call'),
    callId: z.string(),
    receivedAt: z.number(),
    state: z.enum(WEBHOOK_CALL_STATES),
    sample: z.literal(true).optional(),
    runNumber: z.number().optional(),
    reason: z.string().optional()
  }),
  z.looseObject({
    kind: z.enum(['refused', 'over_budget', 'duplicate']),
    minute: z.number(),
    count: z.number()
  })
])

export type PhoneWebhookCall = z.infer<typeof WebhookCallRowSchema>

function webhookWrite<Method extends RpcMethodName, Variant extends string>(
  method: Method,
  variant: Variant
) {
  return bindDeferredRpcOperation(
    defineRpcOperation({
      name: method,
      method,
      acceptance: 'require-result-or-throw-message',
      barrier: 'after-caller-barrier',
      read: rpcResultVariant(variant, z.unknown())
    })
  )
}

export const webhooksListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'webhooks.list',
    method: 'webhooks.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    // A hook or call a newer host words differently drops alone, never the whole list.
    read: rpcResultVariant(
      'webhooks-list',
      z.looseObject({ hooks: salvagingArray(WebhookSummarySchema) })
    )
  })
)

export const webhookCallsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'webhooks.calls',
    method: 'webhooks.calls',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'webhook-calls',
      z.looseObject({ calls: salvagingArray(WebhookCallRowSchema) })
    )
  })
)

export const webhookSample = webhookWrite('webhooks.sample', 'webhook-sampled')
export const webhookPause = webhookWrite('webhooks.pause', 'webhook-paused')
export const webhookDelete = webhookWrite('webhooks.delete', 'webhook-deleted')
export const webhookRotate = webhookWrite('webhooks.rotate', 'webhook-rotated')

/** A generated secret comes back once, to be copied; a pasted one comes back empty. */
export const webhookSecretSet = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'webhooks.secret',
    method: 'webhooks.secret',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('webhook-secret', z.looseObject({ secret: z.string().optional() }))
  })
)
