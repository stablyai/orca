import { EpochMsSchema, SequenceSchema } from '@orca-cloud/push-contract'
import { z } from 'zod'
import { CONNECTOR_LIMITS } from './connector-limits.js'
import {
  WEBHOOK_FILTER_LIMITS,
  WEBHOOK_WHERE_OPS,
  webhookFiltersProblem,
  webhookRuleBytes
} from './webhook-matcher.js'
import {
  WEBHOOK_CALL_ID_PATTERN,
  WEBHOOK_HOOK_ID_PATTERN,
  hookIdOfActor,
  hookIdOfRule
} from './webhook-names.js'
import { WebhookRunIdSchema as RunId } from './webhook-routes.js'

export const WebhookHookIdSchema = z.string().regex(WEBHOOK_HOOK_ID_PATTERN)
export const WebhookCallIdSchema = z.string().regex(WEBHOOK_CALL_ID_PATTERN)

const Id = z.string().min(1).max(CONNECTOR_LIMITS.maxBotIdLength)
const FilterText = z.string().min(1).max(CONNECTOR_LIMITS.maxDisplayTextLength)
const Path = z.string().min(1).max(WEBHOOK_FILTER_LIMITS.maxPathLength)

// A hook's rule on its host, id webhookRuleId(hookId); one per automation. Strict: a filter this cloud
// doesn't know drops the whole rule, so a newer machine's filter is never ignored into a wider hook.
export const ConnectorWebhookTriggerSchema = z
  .strictObject({
    id: z.string().refine((id) => hookIdOfRule(id) !== null),
    automationId: Id,
    botId: Id,
    source: z.literal('webhook'),
    event: z.literal('call'),
    // Raised on each filter edit; the id, and so the URL, stays.
    rev: z.number().int().positive(),
    where: z
      .array(
        z.strictObject({
          path: Path,
          op: z.enum(WEBHOOK_WHERE_OPS),
          values: z.array(FilterText).max(WEBHOOK_FILTER_LIMITS.maxValues).optional()
        })
      )
      .max(WEBHOOK_FILTER_LIMITS.maxWhere)
      .optional(),
    textContains: FilterText.optional(),
    pick: z.array(Path).max(WEBHOOK_FILTER_LIMITS.maxPick).optional(),
    subjectFrom: Path.optional(),
    subject: FilterText.optional(),
    graceMinutes: z.number().int().nonnegative()
  })
  .superRefine((rule, context) => {
    const bytes = webhookRuleBytes(rule)
    const problem =
      webhookFiltersProblem(rule) ??
      (bytes > WEBHOOK_FILTER_LIMITS.maxRuleBytes
        ? `${bytes} bytes, over ${WEBHOOK_FILTER_LIMITS.maxRuleBytes}`
        : null)
    if (problem) {
      context.addIssue({ code: 'custom', message: problem })
    }
  })

// On a trigger event from a hook. The cloud's webhook outbox alone sets it.
export const WebhookCallFieldsSchema = z.object({
  callId: WebhookCallIdSchema,
  // The hook's lifecycle generation at admission; pause, delete and revoke-now raise it.
  epoch: SequenceSchema,
  // Always 1, as hooks never move host; older Orca requires it.
  hostGen: SequenceSchema,
  // Sent from the card's "Send a sample call", never from a caller.
  sample: z.literal(true).optional()
})

const absent = z.never().optional()

// A hook's call, keyed by its callId and done by webhookActorId(hookId), never a person or the owner.
// The host quotes the call it fetches by id, so no text or display string here can leak a key or
// secret.
export const WebhookTriggerEventSchema = z
  .object({
    key: WebhookCallIdSchema,
    actorId: z.string().refine((id) => hookIdOfActor(id) !== null),
    subject: z.string().min(1).max(256).optional(),
    occurredAt: EpochMsSchema,
    webhook: WebhookCallFieldsSchema,
    fromOwner: absent,
    onOwnerMessage: absent,
    actor: absent,
    place: absent,
    url: absent,
    text: absent
  })
  .refine(({ key, webhook }) => key === webhook.callId)

export type ConnectorWebhookTrigger = z.infer<typeof ConnectorWebhookTriggerSchema>
export type WebhookCallFields = z.infer<typeof WebhookCallFieldsSchema>
export type WebhookTriggerEvent = z.infer<typeof WebhookTriggerEventSchema>

export const WEBHOOK_NOTICE_CONDITIONS = ['refusal_burst', 'cap_reached'] as const
export type WebhookNoticeCondition = (typeof WEBHOOK_NOTICE_CONDITIONS)[number]

// The answers to POST /v1/connector/webhook-calls/:callId/start, whose request is in webhook-routes.ts.
export const WebhookCallStartAnswerSchema = z.discriminatedUnion('started', [
  z.object({ started: z.literal(true), runId: RunId.optional() }),
  z.object({ started: z.literal(false), retryAt: z.number() })
])
// 409 names the run that already holds the grant; 410 means the call can never start again.
export const WebhookCallStartConflictSchema = z.object({
  error: z.literal('started_for_another_run'),
  runId: RunId
})
export const WebhookCallStartSettledSchema = z.object({ error: z.literal('settled') })
