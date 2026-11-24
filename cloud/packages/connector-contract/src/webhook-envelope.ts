import { EpochMsSchema } from '@orca-cloud/push-contract'
import { z } from 'zod'

// A call as the cloud keeps it and its host fetches it: the hook's own keys already scrubbed out,
// every header kept but credential, signature, cookie and proxy-added ones. Filters, the stored copy,
// the run's file and its quote all read this, never the raw request.
export const WEBHOOK_ENVELOPE_LIMITS = {
  // What a caller may send; a larger body is a 413.
  maxBodyBytes: 1024 * 1024,
  maxHeaderValueLength: 1024
} as const

export const WebhookEnvelopeBodySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('json'), value: z.unknown() }),
  // Repeated keys become arrays.
  z.object({
    kind: z.literal('form'),
    value: z.record(z.string(), z.union([z.string(), z.array(z.string())]))
  }),
  z.object({ kind: z.literal('text'), value: z.string() })
])

export const WebhookEnvelopeSchema = z.object({
  receivedAt: EpochMsSchema,
  contentType: z.string().max(WEBHOOK_ENVELOPE_LIMITS.maxHeaderValueLength).nullable(),
  headers: z.record(z.string(), z.string().max(WEBHOOK_ENVELOPE_LIMITS.maxHeaderValueLength)),
  body: WebhookEnvelopeBodySchema,
  // The stored body was cut to fit; filters ran on the whole of it first.
  truncated: z.boolean()
})

export type WebhookEnvelopeBody = z.infer<typeof WebhookEnvelopeBodySchema>
export type WebhookEnvelope = z.infer<typeof WebhookEnvelopeSchema>
