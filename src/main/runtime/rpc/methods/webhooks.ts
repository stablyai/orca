import {
  WebhookCallShow,
  WebhookCalls,
  WebhookCard,
  WebhookCheck,
  WebhookDelete,
  WebhookPause,
  WebhookReveal,
  WebhookRotate,
  WebhookSample,
  WebhookSecret,
  WebhooksList
} from '../../../../shared/rpc-contract/webhooks-params'
import type { WebhookHostService } from '../../../webhooks/webhook-host-service'
import { dropWebhookRule } from '../../../webhooks/webhook-hooks'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod } from '../core'

function webhooks(runtime: OrcaRuntimeService): WebhookHostService {
  const service = runtime.getWebhooks()
  if (!service) {
    throw new Error('webhooks_unavailable')
  }
  return service
}

// No CLI command or agent tool calls reveal, rotate or secret: keys stay out of transcripts. Owner
// scope can still reach them, as it can everything on this host.
export const WEBHOOK_METHODS = [
  defineMethod({
    name: 'webhooks.list',
    permission: 'workspace',
    share: 'not-shared',
    params: WebhooksList,
    handler: async ({ botId }, { runtime }) => ({ hooks: await webhooks(runtime).list(botId) })
  }),
  defineMethod({
    name: 'webhooks.card',
    permission: 'workspace',
    share: 'not-shared',
    params: WebhookCard,
    handler: async ({ hookId }, { runtime }) => webhooks(runtime).card(hookId)
  }),
  defineMethod({
    name: 'webhooks.calls',
    permission: 'workspace',
    share: 'not-shared',
    params: WebhookCalls,
    handler: async ({ hookId }, { runtime }) => ({ calls: await webhooks(runtime).calls(hookId) })
  }),
  defineMethod({
    name: 'webhooks.call',
    permission: 'workspace',
    share: 'not-shared',
    params: WebhookCallShow,
    handler: async ({ hookId, callId }, { runtime }) => webhooks(runtime).callText(hookId, callId)
  }),
  defineMethod({
    name: 'webhooks.check',
    permission: 'workspace',
    share: 'not-shared',
    params: WebhookCheck,
    handler: async ({ hookId, filters }, { runtime }) => webhooks(runtime).check(hookId, filters)
  }),
  defineMethod({
    name: 'webhooks.sample',
    permission: 'workspace',
    share: 'not-shared',
    params: WebhookSample,
    handler: async ({ hookId, operationId }, { runtime }) =>
      webhooks(runtime).sample(hookId, operationId)
  }),
  defineMethod({
    name: 'webhooks.pause',
    permission: 'workspace',
    share: 'not-shared',
    params: WebhookPause,
    // One hook per automation, so pausing either is the same. pending: the cloud hasn't confirmed yet.
    handler: async ({ hookId, paused }, { runtime }) => {
      const automation = webhooks(runtime).automationOf(hookId)
      await runtime.updateAutomation(automation.id, { enabled: !paused })
      return { paused, pending: await webhooks(runtime).lifecyclePending(hookId) }
    }
  }),
  defineMethod({
    name: 'webhooks.delete',
    permission: 'workspace',
    share: 'not-shared',
    params: WebhookDelete,
    handler: async ({ hookId }, { runtime }) => {
      // The cloud deletes the hook once nothing here lists its rule.
      await dropWebhookRule<Promise<unknown>>(webhooks(runtime).automationOf(hookId), {
        setTriggers: (id, on) => runtime.updateAutomation(id, { on }),
        remove: (id) => runtime.deleteAutomation(id)
      })
      return { removed: true, pending: await webhooks(runtime).lifecyclePending(hookId) }
    }
  }),
  defineMethod({
    name: 'webhooks.reveal',
    permission: 'workspace',
    share: 'not-shared',
    params: WebhookReveal,
    handler: async ({ hookId }, { runtime }) => webhooks(runtime).reveal(hookId)
  }),
  defineMethod({
    name: 'webhooks.rotate',
    permission: 'workspace',
    share: 'not-shared',
    params: WebhookRotate,
    handler: async ({ hookId, ...body }, { runtime }) => webhooks(runtime).rotate(hookId, body)
  }),
  defineMethod({
    name: 'webhooks.secret',
    permission: 'workspace',
    share: 'not-shared',
    params: WebhookSecret,
    handler: async (params, { runtime }) => webhooks(runtime).setSecret(params)
  })
]
