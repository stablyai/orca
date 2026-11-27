import { z } from 'zod'
import { CONNECTOR_LIMITS } from './connector-limits.js'
import {
  WEBHOOK_ADAPTERS,
  WEBHOOK_CALL_ID_PATTERN,
  WEBHOOK_CALL_STATES,
  WEBHOOK_HOOK_ID_PATTERN
} from './webhook-names.js'

// The machine's webhook routes, all under machine auth and scoped to the calling machine's account
// and host. The desktop compiles this file in for what it sends, so it imports nothing but zod and
// zod-free files. ':hookId' and ':callId' give the route patterns.
const HOOKS = '/v1/connector/webhooks'
const CALLS = '/v1/connector/webhook-calls'
/** The two roots every webhook route sits under. */
export const WEBHOOK_ROUTE_ROOTS = { hooks: HOOKS, calls: CALLS } as const

// Typed to the literal path, so a route registered with ':hookId' or ':callId' names its param.
const hookRoute =
  <Tail extends string>(tail: Tail) =>
  <Id extends string>(hookId: Id) =>
    `${HOOKS}/${hookId}${tail}` as const
const callRoute =
  <Tail extends string>(tail: Tail) =>
  <Id extends string>(callId: Id) =>
    `${CALLS}/${callId}${tail}` as const

export const WEBHOOK_ROUTES = {
  // POST mints; GET ?botId= lists.
  hooks: HOOKS,
  // GET reads, DELETE deletes.
  hook: hookRoute(''),
  state: hookRoute('/state'),
  // The only route that unseals a key.
  reveal: hookRoute('/reveal'),
  rotate: hookRoute('/rotate'),
  secret: hookRoute('/secret'),
  sample: hookRoute('/sample'),
  // GET, newest first.
  calls: hookRoute('/calls'),
  // GET the scrubbed call, while the cloud still keeps it.
  envelope: callRoute('/envelope'),
  // Reserves a run start under the run caps, granted once per call to that run; a repeat for the
  // same run gets the same grant. 409 started_for_another_run {runId}, 410 settled.
  start: callRoute('/start')
} as const

const Version = z.literal(1)
const Id = z.string().min(1).max(CONNECTOR_LIMITS.maxBotIdLength)
const OperationId = z.string().min(1).max(128)
const HookId = z.string().regex(WEBHOOK_HOOK_ID_PATTERN)
const CallId = z.string().regex(WEBHOOK_CALL_ID_PATTERN)

export const WebhookMintRequestSchema = z.object({
  v: Version,
  operationId: OperationId,
  automationId: Id,
  botId: Id
})
export const WebhookStateRequestSchema = z.object({
  v: Version,
  operationId: OperationId,
  state: z.enum(['live', 'paused'])
})
export const WebhookRevealRequestSchema = z.object({ v: Version })
export const WebhookRotateRequestSchema = z.object({
  v: Version,
  operationId: OperationId,
  stopNow: z.boolean()
})
// A pasted secret, or generate for one Orca makes.
export const WebhookSecretRequestSchema = z.object({
  v: Version,
  operationId: OperationId,
  adapter: z.enum(WEBHOOK_ADAPTERS),
  secret: z.string().min(1).max(1024).optional(),
  generate: z.literal(true).optional()
})
export const WebhookSampleRequestSchema = z.object({
  v: Version,
  operationId: z.string().min(1).max(200)
})
export const WebhookRunIdSchema = z.string().min(1).max(200)
// One start grant per call, bound to its run.
export const WebhookCallStartRequestSchema = z.object({ v: Version, runId: WebhookRunIdSchema })

// Each machine call: its method, its route and the body it sends. GETs and DELETE send none.
export const WEBHOOK_OPERATIONS = {
  mint: { method: 'POST', route: 'hooks', request: WebhookMintRequestSchema },
  list: { method: 'GET', route: 'hooks' },
  get: { method: 'GET', route: 'hook' },
  remove: { method: 'DELETE', route: 'hook' },
  setState: { method: 'PUT', route: 'state', request: WebhookStateRequestSchema },
  reveal: { method: 'POST', route: 'reveal', request: WebhookRevealRequestSchema },
  rotate: { method: 'POST', route: 'rotate', request: WebhookRotateRequestSchema },
  setSecret: { method: 'PUT', route: 'secret', request: WebhookSecretRequestSchema },
  sample: { method: 'POST', route: 'sample', request: WebhookSampleRequestSchema },
  calls: { method: 'GET', route: 'calls' },
  envelope: { method: 'GET', route: 'envelope' },
  // runId optional for hosts that don't name their run yet.
  start: {
    method: 'POST',
    route: 'start',
    request: WebhookCallStartRequestSchema.partial({ runId: true })
  }
} as const satisfies Record<
  string,
  {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE'
    route: keyof typeof WEBHOOK_ROUTES
    request?: z.ZodType
  }
>

/** A hook as every route answering one returns it; never a key. */
export const WebhookViewSchema = z.object({
  hookId: HookId,
  automationId: z.string().min(1),
  botId: z.string().min(1),
  state: z.enum(['pending', 'live', 'paused', 'orphaned']),
  epoch: z.number().int().nonnegative(),
  // Always 1, as hooks never move host; older Orca requires it.
  hostGen: z.number().int().nonnegative(),
  // Raised on every rotation, so a card holding an older key knows it changed.
  keyGeneration: z.number().int().nonnegative(),
  // Without the key.
  url: z.string().url(),
  adapter: z.enum(WEBHOOK_ADAPTERS).nullable(),
  // When the overlapping previous key stops working; null when there is none.
  previousKeyExpiresAt: z.number().nullable(),
  lastCall: z
    .object({ at: z.number(), state: z.enum(WEBHOOK_CALL_STATES), signatureValid: z.boolean() })
    .nullable(),
  // Calls admitted but not yet started on the host: what a stop-now rotation would cancel.
  pendingCalls: z.number().int().nonnegative()
})
export const WebhookListSchema = z.object({ hooks: z.array(WebhookViewSchema) })

export const WebhookCallRowSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('call'),
    callId: CallId,
    receivedAt: z.number(),
    state: z.enum(WEBHOOK_CALL_STATES),
    sample: z.literal(true).optional(),
    runId: z.string().optional(),
    reason: z.string().optional()
  }),
  // Refused, over-budget and duplicate requests of one minute, counted together.
  z.object({
    kind: z.enum(['refused', 'over_budget', 'duplicate']),
    minute: z.number(),
    count: z.number().int().positive()
  })
])
export const WebhookCallsSchema = z.object({ calls: z.array(WebhookCallRowSchema) })
export const WebhookRevealedSchema = z.object({ key: z.string().min(1) })
export const WebhookRotatedSchema = z.object({ cancelledCalls: z.number().int().nonnegative() })
// Only a secret Orca generates comes back, for the owner to paste into the sender.
export const WebhookSecretSetSchema = z.object({ secret: z.string().min(1).optional() })
export const WebhookSampleSentSchema = z.object({ callId: CallId })

export type WebhookView = z.infer<typeof WebhookViewSchema>
export type WebhookCallRow = z.infer<typeof WebhookCallRowSchema>
