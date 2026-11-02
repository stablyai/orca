import { z } from 'zod'
import { getCompiledSchema } from '../zod-schema-compilation'
import {
  SessionNotificationSchema,
  type SessionNotification
} from './generated/acp-protocol.generated'

const updateEnvelopeSchema = z.looseObject({
  sessionId: z.string(),
  update: z.looseObject({ sessionUpdate: z.string() })
})

export type AcpSessionEvent =
  | { kind: 'known'; notification: SessionNotification }
  | { kind: 'unrecognized'; sessionId: string; raw: z.infer<typeof updateEnvelopeSchema> }

/** Preserve unknown updates; reject malformed envelopes. */
export function readAcpSessionEvent(params: unknown): AcpSessionEvent | null {
  const envelope = updateEnvelopeSchema.safeParse(params)
  if (!envelope.success) {
    return null
  }
  const parsed = getCompiledSchema(SessionNotificationSchema).safeParse(params)
  return parsed.success
    ? { kind: 'known', notification: parsed.data }
    : { kind: 'unrecognized', sessionId: envelope.data.sessionId, raw: envelope.data }
}
