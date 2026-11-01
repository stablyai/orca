import { EpochMsSchema, OpaqueIdSchema, SequenceSchema } from '@orca-cloud/push-contract'
import { z } from 'zod'
import { CONNECTOR_LIMITS } from './connector-limits.js'
import { ConnectorConversationSchema, PlaceIdSchema } from './connector-wire-scalars.js'

// Polls, acks and events name the hello they belong to. Under any other than the current one the cloud
// answers 409 hello_required and applies nothing; the first poll after a hello lists what is unsettled.
export const ConnectorPollRequestSchema = z.object({ v: z.literal(1), helloRev: SequenceSchema })

const DeliveryBase = {
  deliveryId: OpaqueIdSchema,
  seq: SequenceSchema,
  expiresAt: EpochMsSchema,
  conversation: ConnectorConversationSchema
}

// What the cloud sends. The machine settles a kind or shape it cannot read as {outcome:'unsupported'}.
export const ConnectorDeliverySchema = z.discriminatedUnion('kind', [
  z.object({
    ...DeliveryBase,
    kind: z.literal('start'),
    agent: z.string().min(1),
    placeId: PlaceIdSchema,
    prompt: z.string().min(1)
  }),
  z.object({ ...DeliveryBase, kind: z.literal('send'), text: z.string().min(1) }),
  z.object({
    ...DeliveryBase,
    kind: z.literal('answer'),
    promptId: OpaqueIdSchema,
    optionId: OpaqueIdSchema
  }),
  z.object({ ...DeliveryBase, kind: z.literal('cancel') })
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
  z.object({ outcome: z.literal('accepted'), reopened: z.literal(true).optional() }),
  z.object({ outcome: z.literal('refused'), reason: z.string().min(1) }),
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
export type ConnectorDelivery = z.infer<typeof ConnectorDeliverySchema>
export type ConnectorPollResponse = z.infer<typeof ConnectorPollResponseSchema>
export type ConnectorDeliveryResult = z.infer<typeof ConnectorDeliveryResultSchema>
export type ConnectorAcksRequest = z.infer<typeof ConnectorAcksRequestSchema>
