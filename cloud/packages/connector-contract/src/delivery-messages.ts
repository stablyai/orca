import { EpochMsSchema, OpaqueIdSchema, SequenceSchema } from '@orca-cloud/push-contract'
import { z } from 'zod'
import { CONNECTOR_LIMITS } from './connector-limits.js'
import {
  ConnectorActsForSchema,
  ConnectorConversationSchema,
  PlaceIdSchema
} from './connector-wire-scalars.js'
import { ConnectorEarlierOwnSchema } from './earlier-own-messages.js'
import { OptionalConnectorFailureSchema } from './failure-messages.js'
import {
  ConnectorTriggerEventSchema,
  SourceTriggerEventSchema,
  type ConnectorTriggerEvent
} from './trigger-messages.js'
import { hookIdOfActor, hookIdOfRule } from './webhook-names.js'
import { WEBHOOK_NOTICE_CONDITIONS, WebhookHookIdSchema } from './webhook-messages.js'
import { PrEventSchema } from './pr-event-messages.js'

// Polls, acks and events name the hello they belong to. Under any other than the current one the cloud
// answers 409 hello_required and applies nothing; the first poll after a hello lists what is unsettled.
// holdMs: sent only by a machine on the wake channel; the cloud clamps it to 0..CONNECTOR_WAKE_MAX_HOLD_MS
// and, without it, holds as before.
export const ConnectorPollRequestSchema = z.object({
  v: z.literal(1),
  helloRev: SequenceSchema,
  holdMs: z.number().int().optional()
})

const DeliveryBase = {
  deliveryId: OpaqueIdSchema,
  seq: SequenceSchema,
  expiresAt: EpochMsSchema,
  conversation: ConnectorConversationSchema
}

// Where a bot was asked: a Slack conversation by channel id; a GitHub issue or pull request as
// owner/repo#number; a Linear issue by its key. A kind this cloud can't tell apart is 'channel'.
export const CONNECTOR_ASKER_PLACE_KINDS = [
  'direct_message',
  'group_message',
  'public_channel',
  'private_channel',
  'channel',
  'issue',
  'pull_request'
] as const

const PersonFields = {
  userId: z.string().min(1).max(CONNECTOR_LIMITS.maxBotIdLength),
  name: z.string().min(1).max(CONNECTOR_LIMITS.maxDisplayTextLength).optional()
}

// Set only for a direct human sender verified by the Slack event receiver, using the
// receiving bot installation's workspace and the event's actual author.
export const ConnectorSlackRequesterSchema = z.object({
  teamId: z.string().regex(/^T[A-Z0-9]{1,31}$/),
  userId: z.string().regex(/^[UW][A-Z0-9]{1,31}$/)
})

// What a bot reads before the request, each part under its own label: an earlier message in the
// thread, a message since the last turn from someone without access, the issue as written, or a
// note that the thread couldn't be read. Only to a machine that lists threadCatchUp: a post in the
// thread by a bot (this one from another chat, or another bot) since the chat last saw it, and a
// note that more was posted than fits.
export const ConnectorContextItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('earlier'), ...PersonFields, text: z.string() }),
  z.object({ kind: z.literal('no_access'), ...PersonFields, text: z.string() }),
  z.object({ kind: z.literal('issue'), text: z.string() }),
  z.object({ kind: z.literal('unreadable') }),
  z.object({
    kind: z.literal('bot'),
    name: z.string().min(1).max(CONNECTOR_LIMITS.maxDisplayTextLength).optional(),
    text: z.string()
  }),
  z.object({ kind: z.literal('more') })
])

// Who asked a bot, where, what they wrote and what came before it, on a start or send the cloud
// routed to it. role is decided on userId by canAskBot (owner, or a member the owner added); name
// is only what the source shows. A newer machine builds the prompt from these; an older one reads
// prompt or text, which carry the same words unlabelled.
export const ConnectorAskerSchema = z.object({
  ...PersonFields,
  role: z.enum(['owner', 'member']),
  place: z.object({
    kind: z.enum(CONNECTOR_ASKER_PLACE_KINDS),
    id: z.string().min(1).max(256)
  }),
  text: z.string().min(1),
  context: z.array(ConnectorContextItemSchema),
  // Where they wrote it, and their picture, for the machine's tag on the message.
  url: z.string().url().max(2048).optional(),
  avatarUrl: z.string().url().max(2048).optional(),
  // The message itself as an action ref (slack:T:C:thread:ts), which a bot's reaction goes on.
  messageRef: z.string().min(1).max(2048).optional(),
  // A bare mention's request: the asker's own messages before it (see ConnectorEarlierOwnSchema).
  earlierOwn: ConnectorEarlierOwnSchema.optional(),
  // The Orca bot that wrote it for them (item 167): its words, on their behalf.
  via: z
    .object({
      kind: z.literal('bot'),
      userId: z.string().min(1).max(128),
      name: z.string().min(1).max(CONNECTOR_LIMITS.maxDisplayTextLength)
    })
    .optional(),
  // Another Slack app the owner put on Who can ask wrote it, not a person: userId is its bot user,
  // and no one's permission comes with it. An older machine drops it and reads a member's request.
  app: z.literal(true).optional(),
  slackRequester: ConnectorSlackRequesterSchema.optional(),
  // Orca's own lines for the agent on where it was asked (GitHub: the branch, how to post there),
  // which the chat doesn't show. Only to a machine that lists askerNote; any other reads it in text.
  note: z.string().min(1).max(CONNECTOR_LIMITS.maxAskerNoteLength).optional()
}).refine(
  ({ slackRequester, userId, via, app }) =>
    !slackRequester || (!via && !app && slackRequester.userId === userId),
  { path: ['slackRequester'] }
)

// A hook's call comes only in a webhook conversation, from the hook its rule names; no other event
// carries call fields or names a hook's rule.
function isTriggerFromItsSource(delivery: {
  conversation: { source: string }
  triggerId: string
  event: ConnectorTriggerEvent
}): boolean {
  return delivery.conversation.source === 'webhook'
    ? delivery.event.webhook !== undefined &&
        hookIdOfActor(delivery.event.actorId) === hookIdOfRule(delivery.triggerId)
    : delivery.event.webhook === undefined && hookIdOfRule(delivery.triggerId) === null
}

// A bot automation the asked message also matches, run in the bot's turn instead of on its own. Sent
// only to a machine that lists triggerInTurn; an older one ignores the field.
export const ConnectorTurnAutomationSchema = z.object({
  automationId: OpaqueIdSchema,
  triggerId: OpaqueIdSchema,
  botId: OpaqueIdSchema,
  event: SourceTriggerEventSchema
})
const TurnAutomations = z
  .array(ConnectorTurnAutomationSchema)
  .min(1)
  .max(CONNECTOR_LIMITS.maxTurnAutomations)
  .optional()

// The conversation whose chat answers a thread, and whom that chat acts for (null: not recorded,
// read as the owner only). The machine, which holds both records, decides whether a run joins it.
export const ConnectorThreadOwnerSchema = z.object({
  conversation: ConnectorConversationSchema,
  actsFor: ConnectorActsForSchema.nullable()
})

// A send whose chat is deleted on the machine: the cloud releases the thread and starts a new chat.
export const CHAT_GONE_REFUSAL = 'chat_gone'

// A resume whose chat's newest turn no longer failed (resumed, answered or replaced since).
export const NOT_FAILED_REFUSAL = 'not_failed'
// What a resume's send says, as the app's own Continue does.
export const CONNECTOR_RESUME_TEXT = 'Continue where you left off.'

// A mention of the bot with no words of its own. Its prompt or text (and the asker's text) is
// BARE_MENTION_TEXT. With asker.earlierOwn the machine tells the agent those messages are the request;
// without it, to greet and offer help.
export const BARE_MENTION_TEXT = '(mentioned you with no message)'
const BareMention = z.literal(true).optional()

// When the cloud took the person's message (epoch ms), so a machine that was asleep or offline can
// tell the agent how long it waited. An older machine ignores it.
const AskedAt = EpochMsSchema.optional()

// What the cloud sends. The machine settles a kind or shape it cannot read as {outcome:'unsupported'}.
export const ConnectorDeliverySchema = z.discriminatedUnion('kind', [
  z.object({
    ...DeliveryBase,
    kind: z.literal('start'),
    agent: z.string().min(1),
    placeId: PlaceIdSchema,
    prompt: z.string().min(1),
    // A bot's: an older machine ignores it.
    asker: ConnectorAskerSchema.optional(),
    automations: TurnAutomations,
    bareMention: BareMention,
    askedAt: AskedAt
  }),
  z.object({
    ...DeliveryBase,
    kind: z.literal('send'),
    text: z.string().min(1),
    asker: ConnectorAskerSchema.optional(),
    automations: TurnAutomations,
    bareMention: BareMention,
    askedAt: AskedAt,
    // Resume pressed on the failed turn `turnId` (its turn-started `at`): the machine continues the
    // chat only while its newest turn is still failed, else refuses NOT_FAILED_REFUSAL. Sent only
    // to a machine that lists resume.
    resume: z.object({ turnId: EpochMsSchema }).optional()
  }),
  // An option pressed, or (only to a machine that lists answer.text) the owner's reply to a prompt
  // shown byReply: exactly one of optionId and text.
  z
    .object({
      ...DeliveryBase,
      kind: z.literal('answer'),
      promptId: OpaqueIdSchema,
      optionId: OpaqueIdSchema.optional(),
      text: z.string().min(1).max(CONNECTOR_LIMITS.maxAnswerTextChars).optional()
    })
    .refine((answer) => (answer.optionId === undefined) !== (answer.text === undefined)),
  z.object({
    ...DeliveryBase,
    kind: z.literal('cancel'),
    // A Stop names the turn it was pressed for (its turn-started `at`); a machine that lists
    // turnCancel refuses it once that turn is no longer current.
    turnId: EpochMsSchema.optional()
  }),
  // Sent only to a machine that lists trigger. Its conversation is the event's own, bound to no thread.
  z
    .object({
      ...DeliveryBase,
      kind: z.literal('trigger'),
      automationId: OpaqueIdSchema,
      triggerId: OpaqueIdSchema,
      // The bot the rule was listed for; the machine refuses it once the automation runs as another.
      botId: OpaqueIdSchema,
      // Bound to the event's thread: the run may answer there. Absent, the cloud bound none.
      inThread: z.literal(true).optional(),
      // The chat that owns the event's thread, for an inThread run; the machine may run it there.
      owner: ConnectorThreadOwnerSchema.optional(),
      event: ConnectorTriggerEventSchema
    })
    .refine(isTriggerFromItsSource),
  z.object({
    ...DeliveryBase,
    kind: z.literal('webhook_notice'),
    hookId: WebhookHookIdSchema,
    botId: OpaqueIdSchema,
    condition: z.enum(WEBHOOK_NOTICE_CONDITIONS),
    count: z.number().int().nonnegative(),
    at: EpochMsSchema
  }),
  // Sent only to a machine that lists prEvents. Its conversation is its pull request's; the machine
  // finds the worker, and so the thread, it belongs to.
  z.object({
    ...DeliveryBase,
    kind: z.literal('pr_event'),
    event: PrEventSchema
  })
])

const absent = z.never().optional()

// Exactly one known control per poll; added fields are still ignored, as everywhere else.
const PollControlSchema = z.union([
  z.object({ stop: z.string().min(1), pausedForMs: absent, reconnect: absent }),
  z.object({ pausedForMs: z.number().int().positive(), stop: absent, reconnect: absent }),
  z.object({ reconnect: z.literal(true), stop: absent, pausedForMs: absent })
])

export const ConnectorPollResponseSchema = z.object({
  v: z.literal(1),
  serverNow: EpochMsSchema,
  holdMs: z.number().int().nonnegative().lt(CONNECTOR_LIMITS.pollTimeoutMs),
  // First poll after a hello only: deliveries received but never done, including by an earlier process.
  unsettled: z
    .array(z.object({ deliveryId: OpaqueIdSchema, conversation: ConnectorConversationSchema }))
    .optional(),
  deliveries: z.array(ConnectorDeliverySchema).max(CONNECTOR_LIMITS.maxDeliveriesPerPoll),
  control: PollControlSchema.optional()
})

export const ConnectorDeliveryResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('accepted'),
    reopened: z.literal(true).optional(),
    // The machine ran the automations the start or send carried, in its turn.
    inTurn: z.literal(true).optional()
  }),
  z.object({
    outcome: z.literal('refused'),
    reason: z.string().min(1),
    failure: OptionalConnectorFailureSchema
  }),
  // Includes `no_local_record` when a restart finds no receipt; never resent.
  z.object({ outcome: z.literal('unknown'), reason: z.string().min(1) }),
  z.object({ outcome: z.literal('expired') }),
  z.object({ outcome: z.literal('unsupported') })
])

// received once the seam call has written its receipt; done when it settles. First done wins.
export const ConnectorAcksRequestSchema = z.object({
  v: z.literal(1),
  helloRev: SequenceSchema,
  acks: z
    .array(
      z.discriminatedUnion('step', [
        z.object({ deliveryId: OpaqueIdSchema, step: z.literal('received') }),
        z.object({
          deliveryId: OpaqueIdSchema,
          step: z.literal('done'),
          result: ConnectorDeliveryResultSchema
        })
      ])
    )
    .min(1)
})

export type ConnectorPollRequest = z.infer<typeof ConnectorPollRequestSchema>
export type ConnectorAsker = z.infer<typeof ConnectorAskerSchema>
export type ConnectorContextItem = z.infer<typeof ConnectorContextItemSchema>
export type ConnectorThreadOwner = z.infer<typeof ConnectorThreadOwnerSchema>
export type ConnectorDelivery = z.infer<typeof ConnectorDeliverySchema>
export type ConnectorPollResponse = z.infer<typeof ConnectorPollResponseSchema>
export type ConnectorDeliveryResult = z.infer<typeof ConnectorDeliveryResultSchema>
export type ConnectorAcksRequest = z.infer<typeof ConnectorAcksRequestSchema>
