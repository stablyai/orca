import { createHash } from 'node:crypto'
import type { StructuredAttentionOrigin } from '../../shared/agent-session-attention'

export function structuredPushOccurrence(
  subject: string | undefined,
  origin: StructuredAttentionOrigin | undefined
): string | undefined {
  return subject && origin
    ? createHash('sha256')
        .update(
          JSON.stringify([subject, origin.journalCursor.epoch, origin.journalCursor.sequence])
        )
        .digest('base64url')
    : undefined
}
