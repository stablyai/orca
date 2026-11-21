// The RPCs the chat's bot cards call, all on the phone's bot allowlist.
import * as z from 'zod'
import { WEBHOOK_ADAPTERS } from '../../../../../../src/shared/connector-webhook-contract'
import { GoogleSetupRunSchema } from '../../../../../../src/shared/google/google-setup-run'
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

const GoogleSetupReadingSchema = z.looseObject({
  run: GoogleSetupRunSchema.nullable(),
  // Kept as sent; the card reads only the kinds and buttons it knows (mobile-google-setup-store).
  blocker: z.unknown()
})

export const googleSetupRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.googleSetup.read',
    method: 'bots.googleSetup.read',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('google-setup', GoogleSetupReadingSchema)
  })
)

/** Records the owner's card answer; the host replies with the run and where it's stuck now. */
export const googleSetupAnswer = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.googleSetup.answer',
    method: 'bots.googleSetup.answer',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('google-setup-answered', GoogleSetupReadingSchema)
  })
)

/** The host's Google app and accounts, for its client id and what each account can use; `check` asks
 *  Google again first. */
export const googleStatusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'google.status',
    method: 'google.status',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'google-status',
      z.looseObject({
        client: z.looseObject({ clientId: z.string() }).nullable().optional(),
        accounts: z
          .array(
            z.looseObject({
              email: z.string(),
              services: z.array(z.looseObject({ service: z.string(), state: z.string() }))
            })
          )
          .optional()
      })
    )
  })
)
