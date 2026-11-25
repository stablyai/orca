import { EpochMsSchema, OpaqueIdSchema, SequenceSchema } from '@orca-cloud/push-contract'
import { z } from 'zod'
import { CONNECTOR_LIMITS } from './connector-limits.js'
import {
  ConnectorActsForSchema,
  ConnectorConversationSchema,
  ConnectorPostNoticesSchema,
  ConnectorTurnForSchema
} from './connector-wire-scalars.js'
import { OptionalConnectorFailureSchema } from './failure-messages.js'

const PromptOptionSchema = z.object({
  id: OpaqueIdSchema,
  // The seam keeps an agent's blank option labels and question text as they are.
  label: z.string(),
  description: z.string().min(1).optional()
})

const textEncoder = new TextEncoder()
const utf8Bytes = (text: string) => textEncoder.encode(text).byteLength

// Who raised a prompt, sent with a bot link's prompts only to a cloud that lists prompts.audience.
// 'conversation': the turn its conversation asked for; 'orca': anything else (mail from another bot,
// a turn typed in Orca, a conversation the chat no longer answers). Absent (an older machine) reads
// 'conversation', as before; a value this cloud can't read reads 'orca', the most restrictive.
// wokenBy: with 'orca', who woke the turn. open: the chat (and its item) an Orca link opens.
// byReply: exactly one option-less free-text question, so the owner's reply can answer it.
const PromptAudience = {
  raisedBy: z.enum(['conversation', 'orca']).optional().catch('orca'),
  wokenBy: z
    .string()
    .min(1)
    .max(CONNECTOR_LIMITS.maxPromptWokenByChars)
    .optional()
    .catch(undefined),
  open: z
    .object({ sessionId: OpaqueIdSchema, itemId: OpaqueIdSchema.optional() })
    .optional()
    .catch(undefined),
  byReply: z.literal(true).optional().catch(undefined)
}

export const ConnectorPendingPromptSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('approval'),
    promptId: OpaqueIdSchema,
    tool: z.string().min(1),
    summary: z.string().min(1).optional(),
    options: z.array(PromptOptionSchema),
    ...PromptAudience
  }),
  z.object({
    kind: z.literal('question'),
    promptId: OpaqueIdSchema,
    question: z.string(),
    header: z.string().min(1).optional(),
    options: z.array(PromptOptionSchema),
    ...PromptAudience
  }),
  // Only Orca's own views can answer it. text: what it asks (its header, each question and its
  // options), for a card that links to Orca; one too long is dropped.
  z.object({
    kind: z.literal('unsupported'),
    promptId: OpaqueIdSchema,
    text: z
      .string()
      .min(1)
      .refine((text) => utf8Bytes(text) <= CONNECTOR_LIMITS.maxPromptTextBytes)
      .optional()
      .catch(undefined),
    ...PromptAudience
  })
])

// The pull requests a conversation's work opened, as the machine's work record knows them (an
// enterprise host may be http). A link a cloud can't read is dropped, never its list or batch.
export const ConnectorWorkLinkSchema = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2048),
  title: z.string().min(1).max(CONNECTOR_LIMITS.maxDisplayTextLength)
})
const OptionalWorkLinksSchema = z
  .array(z.unknown())
  .max(CONNECTOR_LIMITS.maxWorkLinks)
  .optional()
  .catch(undefined)
  .transform((items) =>
    items?.flatMap((item) => {
      const link = ConnectorWorkLinkSchema.safeParse(item)
      return link.success ? [link.data] : []
    })
  )

const PaneEvent = { conversation: ConnectorConversationSchema, paneKey: OpaqueIdSchema }

// How an admitted request ended, from the machine that ran it. quiet: the bot chose silence.
// no_answer: the turn succeeded and wrote nothing. unattributed: answered together with earlier
// messages. cleared / not_found: the chat was rewound or cleared, or no longer has the request.
export const CONNECTOR_REPLY_OUTCOMES = [
  'answered',
  'quiet',
  'no_answer',
  'interrupted',
  'failed',
  'cancelled',
  'withdrawn',
  'cleared',
  'not_found',
  'unattributed'
] as const
export const ConnectorReplyOutcomeSchema = z.enum(CONNECTOR_REPLY_OUTCOMES)

// Prose is the answer: present, with words, and within the answer limit exactly when answered.
// turnId: the turn its machine recorded as answering these deliveries (its turn-started `at`); a
// cloud closes that turn on it. The delivery ids key everything else.
export const ConnectorReplyEventSchema = z
  .object({
    kind: z.literal('reply'),
    conversation: ConnectorConversationSchema,
    deliveryIds: z
      .array(OpaqueIdSchema)
      .min(1)
      .max(CONNECTOR_LIMITS.maxReplyDeliveryIds)
      .refine((ids) => new Set(ids).size === ids.length),
    answerDeliveryId: OpaqueIdSchema,
    outcome: ConnectorReplyOutcomeSchema,
    // Words to post: never only whitespace, which no source would show.
    prose: z
      .string()
      .refine((text) => text.trim().length > 0)
      .refine((text) => utf8Bytes(text) <= CONNECTOR_LIMITS.maxLongAnswerBytes)
      .optional(),
    failure: OptionalConnectorFailureSchema,
    links: OptionalWorkLinksSchema,
    turnId: EpochMsSchema.optional(),
    // How long the answered turn ran, by the machine's clock; shown under the answer.
    tookMs: z.number().int().positive().optional(),
    // A turn done without an answer ran a tool call that may have acted; its line asks to check first.
    toolsRan: z.literal(true).optional()
  })
  .refine((reply) => reply.deliveryIds.includes(reply.answerDeliveryId))
  .refine((reply) => (reply.outcome === 'answered') === (reply.prose !== undefined))

const ActivityTextSchema = z.string().min(1).max(CONNECTOR_LIMITS.maxActivityTextChars)

// text: the tool the turn is inside, in words ("Running pnpm test"); absent between tools. steps: its
// plan, in order, when the agent keeps one. turnId: the turn-started `at`.
export const ConnectorActivityEventSchema = z.object({
  ...PaneEvent,
  kind: z.literal('activity'),
  turnId: EpochMsSchema,
  text: ActivityTextSchema.optional(),
  steps: z
    .array(
      z.object({
        title: ActivityTextSchema,
        status: z.enum(['pending', 'in_progress', 'completed'])
      })
    )
    .max(CONNECTOR_LIMITS.maxActivitySteps)
    .optional()
})
export type ConnectorActivityEvent = z.infer<typeof ConnectorActivityEventSchema>

// Identities: linked by pane, prompt by pane + promptId, a turn by pane + its turn-started `at` (turnId).
// actsFor: whom the linked chat acts for, once recorded; an older machine leaves it out.
export const ConnectorEventSchema = z.discriminatedUnion('kind', [
  z.object({
    ...PaneEvent,
    kind: z.literal('linked'),
    agent: z.string().min(1),
    actsFor: ConnectorActsForSchema.optional()
  }),
  // Sent only to a cloud that lists threads.owner: whom a linked chat acts for, recorded after its
  // link (a mention chat's first asker); and that a linked chat is gone, so its thread is free.
  z.object({ ...PaneEvent, kind: z.literal('acts-for'), actsFor: ConnectorActsForSchema }),
  z.object({ ...PaneEvent, kind: z.literal('unlinked') }),
  z.object({
    ...PaneEvent,
    kind: z.literal('prompt'),
    prompt: ConnectorPendingPromptSchema,
    // The agent worked past this prompt in Orca; its card closes as answered there.
    answered: z.literal(true).optional(),
    // With answered: the option labels chosen in Orca; absent for free text or when unreadable.
    answeredWith: z
      .string()
      .min(1)
      .max(CONNECTOR_LIMITS.maxPromptAnsweredWithChars)
      .optional()
      .catch(undefined)
  }),
  z.object({
    ...PaneEvent,
    kind: z.literal('turn-started'),
    at: EpochMsSchema,
    // The delivery the turn answers, when exactly one started it; an older machine leaves it out.
    deliveryId: OpaqueIdSchema.optional()
  }),
  z.object({
    ...PaneEvent,
    kind: z.literal('turn-ended'),
    // The turn-started `at` of the turn that ended, so start, end and replies share one id.
    turnId: EpochMsSchema,
    at: EpochMsSchema,
    // The host's turn verdict; null when none was recorded.
    stopReason: z.string().min(1).nullable(),
    lastAssistantMessage: z
      .string()
      .refine(
        (text) => utf8Bytes(text) <= CONNECTOR_LIMITS.maxLongAnswerBytes
      )
      .optional(),
    // A chat turn's cause; someone typing in Orca ('local') is not mirrored back.
    origin: z.enum(['delivery', 'local']).optional(),
    // Why a failed turn failed; absent from older machines and turns that didn't fail.
    failure: OptionalConnectorFailureSchema,
    links: OptionalWorkLinksSchema,
    // The thread's turn state only: its answer goes as a `reply` (or through replies), never this.
    stateOnly: z.literal(true).optional(),
    // Whom a turn no delivery started acts for; its final post counts as that person on Slack.
    turnFor: ConnectorTurnForSchema.optional(),
    // With a usage-limit failure that has a reset: the machine continues the turn's requests by
    // itself then. Sent only to a cloud that lists replies.paused.
    resumes: z.literal(true).optional().catch(undefined)
  }),
  // Sent only to a cloud whose hello answer lists replies.outbox: the outcome of the admitted
  // deliveries one turn answered in one conversation. answerDeliveryId (the earliest of them) keys
  // the answer, so every retry and replay posts it once.
  ConnectorReplyEventSchema,
  // Whether orchestration workers the conversation's agent started still run, sent only to a cloud
  // whose hello answer lists `workers`. Running keeps the conversation working after its turn ends.
  z.object({ ...PaneEvent, kind: z.literal('workers'), running: z.boolean() }),
  // What a running turn is doing now, sent only to a cloud whose hello answer lists `turn.activity`,
  // a few seconds apart at most. The thread's working status shows it; an older or ended turn's
  // changes nothing.
  ConnectorActivityEventSchema,
  // Batch 0 after each hello. Not working never means done: an open turn reads unverifiable.
  z.object({
    kind: z.literal('snapshot'),
    // Linked conversations active in the last snapshotActiveWindowMs, newest first.
    conversations: z
      .array(
        z.object({
          ...PaneEvent,
          agent: z.string().min(1),
          working: z.boolean(),
          prompt: ConnectorPendingPromptSchema.nullable(),
          // The pane's latest turn (its turn-started `at`), working or not; a turn end older than it
          // changes nothing.
          turnId: EpochMsSchema.optional(),
          // Its workers, as the `workers` event tells them; absent while the machine doesn't know.
          workersRunning: z.boolean().optional()
        })
      )
      .max(CONNECTOR_LIMITS.maxSnapshotConversations)
  })
])

const fitsOneEvent = (event: unknown) =>
  utf8Bytes(JSON.stringify(event)) <= CONNECTOR_LIMITS.maxEventBytes

// The machine sends all its event batches through one FIFO queue and starts the next only once the cloud
// took the head. It fills each batch by bytes, under maxRequestBytes. seq counts batches from 0 after each hello; a retry resends the same body, helloRev and
// seq. The cloud applies a batch only for the current helloRev (refusing any other with 409) and above
// that hello's high-water mark, so a late original never undoes newer state.
export const CONNECTOR_AUDIENCE_EVENTS_VERSION = 2

export const ConnectorEventsRequestSchema = z
  .object({
    v: z.union([z.literal(1), z.literal(CONNECTOR_AUDIENCE_EVENTS_VERSION)]),
    helloRev: SequenceSchema,
    seq: SequenceSchema,
    events: z.array(ConnectorEventSchema.refine(fitsOneEvent)).min(1)
  })
  .refine(
    ({ v, events }) =>
      v === CONNECTOR_AUDIENCE_EVENTS_VERSION ||
      events.every((event) =>
        event.kind === 'prompt'
          ? event.prompt.raisedBy !== 'orca'
          : event.kind !== 'snapshot' ||
            event.conversations.every((conversation) => conversation.prompt?.raisedBy !== 'orca')
      ),
    { message: 'Private prompts require audience-aware event requests' }
  )

// One inline note on a pull request's diff: a file, a line in its new version (LEFT: the old one),
// and what it says.
export const ConnectorReviewCommentSchema = z.object({
  path: z.string().min(1).max(CONNECTOR_LIMITS.maxReviewPathLength),
  line: z.number().int().positive(),
  side: z.enum(['LEFT', 'RIGHT']).optional(),
  body: z.string().min(1).max(CONNECTOR_LIMITS.maxReviewCommentChars)
})

// replyId is minted once by the CLI and kept across retries; turnId is the turn-started `at`. A
// review (sent only to a cloud whose hello answer lists `review`) posts as one pull request review
// whose body is the text; where a source has no reviews, its notes follow the text.
// answerDeliveryId: the delivery whose answer this is (a reply event's answerDeliveryId), so the
// reply and that answer share one key; left out when the turn can't be named.
export const ConnectorReplyRequestSchema = z.object({
  v: z.literal(1),
  replyId: OpaqueIdSchema,
  conversation: ConnectorConversationSchema,
  turnId: EpochMsSchema,
  text: z.string().min(1),
  answerDeliveryId: OpaqueIdSchema.optional(),
  // Whom the turn acts for when no delivery started it (see ConnectorTurnForSchema).
  turnFor: ConnectorTurnForSchema.optional(),
  review: z
    .object({
      comments: z.array(ConnectorReviewCommentSchema).min(1).max(CONNECTOR_LIMITS.maxReviewComments)
    })
    .optional()
})

// notices: why the reply can't wake an Orca bot it mentions; an older machine drops them.
export const ConnectorReplyResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('posted'),
    messageId: z.string().min(1),
    notices: ConnectorPostNoticesSchema.optional()
  }),
  z.object({ status: z.literal('queued'), notices: ConnectorPostNoticesSchema.optional() })
])

export type ConnectorPendingPrompt = z.infer<typeof ConnectorPendingPromptSchema>
export type ConnectorEvent = z.infer<typeof ConnectorEventSchema>
export type ConnectorEventsRequest = z.infer<typeof ConnectorEventsRequestSchema>
export type ConnectorReplyRequest = z.infer<typeof ConnectorReplyRequestSchema>
export type ConnectorWorkLink = z.infer<typeof ConnectorWorkLinkSchema>
export type ConnectorReviewComment = z.infer<typeof ConnectorReviewCommentSchema>
export type ConnectorReplyEvent = z.infer<typeof ConnectorReplyEventSchema>
export type ConnectorReplyOutcome = z.infer<typeof ConnectorReplyOutcomeSchema>
export type ConnectorReplyResponse = z.infer<typeof ConnectorReplyResponseSchema>
