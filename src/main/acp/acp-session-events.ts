import { z } from 'zod'
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

/** A `session/update`, typed when this build knows its kind; null when it is not one at all. */
export function readAcpSessionEvent(params: unknown): AcpSessionEvent | null {
  const envelope = updateEnvelopeSchema.safeParse(params)
  if (!envelope.success) {
    return null
  }
  const parsed = SessionNotificationSchema.safeParse(params)
  return parsed.success
    ? { kind: 'known', notification: parsed.data }
    : { kind: 'unrecognized', sessionId: envelope.data.sessionId, raw: envelope.data }
}
