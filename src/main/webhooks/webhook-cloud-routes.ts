// The machine's webhook routes in Orca Cloud, as calls; the paths and answers are the shared mirror's.
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import {
  WEBHOOK_OPERATIONS,
  WEBHOOK_ROUTES
} from '../../../cloud/packages/connector-contract/src/webhook-routes'
import { WebhookCallStartAnswer } from '../../shared/connector-webhook-contract'
import {
  WebhookCalls,
  WebhookEnvelope,
  WebhookRevealed,
  WebhookRotated,
  WebhookSampleSent,
  WebhookSecretSet,
  WebhookView
} from '../../shared/connector-webhook-routes'
import {
  automationWebhookTrigger,
  webhookIsOnlyStart
} from '../../shared/automation-event-triggers'
import type { Automation } from '../../shared/automations/automation-definition'
import type { WebhookSummary } from '../../shared/rpc-contract/webhooks-params'
import type { ConnectorCloud } from '../connector-cloud/connector-cloud'
import type { ConnectorResult } from '../connector-cloud/connector-cloud-request'

const START_TIMEOUT_MS = 5000

type WebhookOperation = keyof typeof WEBHOOK_OPERATIONS
type WebhookOperationWithBody = {
  [K in WebhookOperation]: (typeof WEBHOOK_OPERATIONS)[K] extends { request: z.ZodType } ? K : never
}[WebhookOperation]
/** What a call sends, less the version every body carries. */
type WebhookRequestBody<K extends WebhookOperationWithBody> = Omit<
  z.infer<(typeof WEBHOOK_OPERATIONS)[K]['request']>,
  'v'
>

export const CloudWebhookList = lazyZodSchema(() => z.object({ hooks: z.array(WebhookView) }))

type Cloud = Pick<ConnectorCloud, 'call' | 'withConnection'>

/** The routes above, as calls; null while no cloud can be reached as this machine. */
export function webhookCloudCalls(cloud: () => Cloud | null) {
  const read = <TSchema extends z.ZodType>(
    operation: Exclude<WebhookOperation, WebhookOperationWithBody>,
    path: string,
    schema: TSchema
  ): Promise<ConnectorResult<z.infer<TSchema>>> | null =>
    cloud()?.call(path, undefined, schema, { method: WEBHOOK_OPERATIONS[operation].method }) ?? null
  const write = <K extends WebhookOperationWithBody, TSchema extends z.ZodType>(
    operation: K,
    path: string,
    body: WebhookRequestBody<K>,
    schema: TSchema,
    timeoutMs?: number
  ): Promise<ConnectorResult<z.infer<TSchema>>> | null =>
    cloud()?.call(path, { v: 1, ...body }, schema, {
      method: WEBHOOK_OPERATIONS[operation].method,
      timeoutMs
    }) ?? null
  return {
    // A bot's first hook is minted before any rule names it: the cloud knows the bot only once this host says hello.
    mint: (body: WebhookRequestBody<'mint'>) =>
      cloud()?.withConnection(
        async () => (await write('mint', WEBHOOK_ROUTES.hooks, body, WebhookView)) ?? null
      ) ?? null,
    list: (botId: string) =>
      read('list', `${WEBHOOK_ROUTES.hooks}?botId=${encodeURIComponent(botId)}`, CloudWebhookList),
    get: (hookId: string) => read('get', WEBHOOK_ROUTES.hook(hookId), WebhookView),
    setState: (hookId: string, body: WebhookRequestBody<'setState'>) =>
      write('setState', WEBHOOK_ROUTES.state(hookId), body, WebhookView),
    remove: (hookId: string) => read('remove', WEBHOOK_ROUTES.hook(hookId), z.undefined()),
    reveal: (hookId: string, body: WebhookRequestBody<'reveal'>) =>
      write('reveal', WEBHOOK_ROUTES.reveal(hookId), body, WebhookRevealed),
    rotate: (hookId: string, body: WebhookRequestBody<'rotate'>) =>
      write('rotate', WEBHOOK_ROUTES.rotate(hookId), body, WebhookRotated),
    setSecret: (hookId: string, body: WebhookRequestBody<'setSecret'>) =>
      write('setSecret', WEBHOOK_ROUTES.secret(hookId), body, WebhookSecretSet),
    sample: (hookId: string, operationId: string) =>
      write('sample', WEBHOOK_ROUTES.sample(hookId), { operationId }, WebhookSampleSent),
    calls: (hookId: string) => read('calls', WEBHOOK_ROUTES.calls(hookId), WebhookCalls),
    envelope: (callId: string) =>
      read('envelope', WEBHOOK_ROUTES.envelope(callId), WebhookEnvelope),
    start: (callId: string, runId: string) =>
      // Asked inside the automation's lane, so a slow cloud holds its other events only briefly.
      write(
        'start',
        WEBHOOK_ROUTES.start(callId),
        { runId },
        WebhookCallStartAnswer,
        START_TIMEOUT_MS
      )
  }
}

export type WebhookCloudCalls = ReturnType<typeof webhookCloudCalls>

/** What the card and row show, from the cloud's hook and the automation that lists it here. */
export function webhookSummary(
  hook: WebhookView,
  automation: Pick<Automation, 'name' | 'bot' | 'on' | 'dtstart'>
): WebhookSummary {
  const {
    id: _id,
    source: _source,
    event: _event,
    rev: _rev,
    ...filters
  } = automationWebhookTrigger(automation) ?? {}
  return {
    hookId: hook.hookId,
    botId: hook.botId,
    automationId: hook.automationId,
    state: hook.state,
    url: hook.url,
    adapter: hook.adapter,
    lastCall: hook.lastCall,
    pendingCalls: hook.pendingCalls,
    keyGeneration: hook.keyGeneration,
    previousKeyExpiresAt: hook.previousKeyExpiresAt,
    automationName: automation.name,
    deletesAutomation: webhookIsOnlyStart(automation),
    filters,
    resultsTo: automation.bot?.resultsTo ?? 'chat',
    // This is the hook's host; a viewer elsewhere says offline or needs an update itself.
    host: 'online'
  }
}

/** The read's value; a failed read throws one of WEBHOOK_ERROR_CODES. */
export function webhookReadValue<T>(result: ConnectorResult<T> | null): T {
  if (!result) {
    throw new Error('webhooks_unavailable')
  }
  if (!result.ok) {
    throw new Error(
      result.status === 404 && result.error !== null ? 'webhook_not_found' : 'webhooks_unavailable'
    )
  }
  return result.value
}
