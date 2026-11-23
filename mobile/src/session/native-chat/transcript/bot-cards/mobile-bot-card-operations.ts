// The RPCs the chat's bot cards call, all on the phone's bot allowlist.
import * as z from 'zod'
import { WEBHOOK_ADAPTERS } from '../../../../../../src/shared/connector-webhook-contract'
import {
  bindDeferredRpcOperation,
  defineRpcOperation
} from '../../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../../transport/rpc/rpc-operation-result-reader'

const BotRequestReadingSchema = z.looseObject({
  outcome: z.enum(['answered', 'posted', 'unanswered', 'dropped']).nullable(),
  answer: z.string().nullable(),
  mailIds: z.array(z.string()).optional(),
  chatId: z.string().nullable().optional()
})

export const botRequestOutcomeRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.request.outcome',
    method: 'bots.request.outcome',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-request-outcome', BotRequestReadingSchema)
  })
)

const OwnToolSchema = z.looseObject({
  name: z.string(),
  detail: z.string(),
  remote: z.boolean(),
  signIn: z.looseObject({ state: z.string() }).optional()
})

export const botToolsListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.tools.list',
    method: 'bots.tools.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    // Another agent's bot has no own tools here; its card reads as added.
    read: rpcResultVariant('bot-tools', z.looseObject({ own: z.array(OwnToolSchema).optional() }))
  })
)

export const botToolRemove = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.tools.remove',
    method: 'bots.tools.remove',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-tool-removed', z.unknown())
  })
)

export const webhookCardRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'webhooks.card',
    method: 'webhooks.card',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'webhook-card',
      z.looseObject({
        hookId: z.string(),
        botId: z.string(),
        state: z.enum(['pending', 'live', 'paused', 'orphaned']),
        url: z.string(),
        automationName: z.string(),
        adapter: z.enum(WEBHOOK_ADAPTERS).nullable().optional(),
        lastCall: z
          .looseObject({ at: z.number(), signatureValid: z.boolean() })
          .nullable()
          .optional()
      })
    )
  })
)

/** The hook's key-bearing URL, fetched on the owner's tap and never shown. */
export const webhookKeyReveal = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'webhooks.reveal',
    method: 'webhooks.reveal',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('webhook-key', z.looseObject({ url: z.string() }))
  })
)
