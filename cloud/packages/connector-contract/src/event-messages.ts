import { EpochMsSchema, OpaqueIdSchema, SequenceSchema } from '@orca-cloud/push-contract'
import { z } from 'zod'
import { CONNECTOR_LIMITS } from './connector-limits.js'
import { ConnectorConversationSchema } from './connector-wire-scalars.js'

const PromptOptionSchema = z.object({
  id: OpaqueIdSchema,
  // The seam keeps an agent's blank option labels and question text as they are.
  label: z.string(),
  description: z.string().min(1).optional()
})

export const ConnectorPendingPromptSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('approval'),
    promptId: OpaqueIdSchema,
    tool: z.string().min(1),
    summary: z.string().min(1).optional(),
    options: z.array(PromptOptionSchema)
  }),
  z.object({
    kind: z.literal('question'),
    promptId: OpaqueIdSchema,
    question: z.string(),
    header: z.string().min(1).optional(),
    options: z.array(PromptOptionSchema)
  }),
  // Only Orca's own views can answer it.
  z.object({ kind: z.literal('unsupported'), promptId: OpaqueIdSchema })
])

const textEncoder = new TextEncoder()
const PaneEvent = { conversation: ConnectorConversationSchema, paneKey: OpaqueIdSchema }

// Identities: linked by pane, prompt by pane + promptId, a turn by pane + its turn-started `at` (turnId).
export const ConnectorEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...PaneEvent, kind: z.literal('linked'), agent: z.string().min(1) }),
  z.object({ ...PaneEvent, kind: z.literal('prompt'), prompt: ConnectorPendingPromptSchema }),
  z.object({ ...PaneEvent, kind: z.literal('turn-started'), at: EpochMsSchema }),
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
        (text) =>
          textEncoder.encode(text).byteLength <= CONNECTOR_LIMITS.maxLastAssistantMessageBytes
      )
      .optional()
  }),
  // Batch 0 after each hello. Not working never means done: an open turn reads unverifiable.
  z.object({
    kind: z.literal('snapshot'),
    // Linked conversations active in the last snapshotActiveWindowMs, newest first.
    conversations: z.array(
      z.object({
        ...PaneEvent,
        agent: z.string().min(1),
        working: z.boolean(),
        prompt: ConnectorPendingPromptSchema.nullable(),
        // The pane's latest turn (its turn-started `at`), working or not; a turn end older than it
        // changes nothing.
        turnId: EpochMsSchema.optional()
      })
    ).max(CONNECTOR_LIMITS.maxSnapshotConversations)
  })
])

const fitsOneEvent = (event: unknown) =>
  textEncoder.encode(JSON.stringify(event)).byteLength <= CONNECTOR_LIMITS.maxEventBytes

// The machine sends all its event batches through one FIFO queue and starts the next only once the cloud
// took the head. It fills each batch by bytes, under maxRequestBytes. seq counts batches from 0 after each hello; a retry resends the same body, helloRev and
// seq. The cloud applies a batch only for the current helloRev (refusing any other with 409) and above
// that hello's high-water mark, so a late original never undoes newer state.
export const ConnectorEventsRequestSchema = z.object({
  v: z.literal(1),
  helloRev: SequenceSchema,
  seq: SequenceSchema,
  events: z.array(ConnectorEventSchema.refine(fitsOneEvent)).min(1)
})

// replyId is minted once by the CLI and kept across retries; turnId is the turn-started `at`.
export const ConnectorReplyRequestSchema = z.object({
  v: z.literal(1),
  replyId: OpaqueIdSchema,
  conversation: ConnectorConversationSchema,
  turnId: EpochMsSchema,
  text: z.string().min(1)
})

export const ConnectorReplyResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('posted'), messageId: z.string().min(1) }),
  z.object({ status: z.literal('queued') })
])

export type ConnectorPendingPrompt = z.infer<typeof ConnectorPendingPromptSchema>
export type ConnectorEvent = z.infer<typeof ConnectorEventSchema>
export type ConnectorEventsRequest = z.infer<typeof ConnectorEventsRequestSchema>
export type ConnectorReplyRequest = z.infer<typeof ConnectorReplyRequestSchema>
export type ConnectorReplyResponse = z.infer<typeof ConnectorReplyResponseSchema>
