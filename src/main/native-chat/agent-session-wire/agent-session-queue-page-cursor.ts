import { z } from 'zod'
import { AGENT_SESSION_QUEUE_SOURCES } from '../../../shared/agent-session-queue-pages'

const Scope = z.object({ sessionId: z.string(), generation: z.string() })
const PageCursor = Scope.extend({
  source: z.enum(AGENT_SESSION_QUEUE_SOURCES).nullable(),
  position: z.number().finite(),
  messageId: z.string(),
  direction: z.enum(['before', 'after'])
}).strict()
const BodyCursor = Scope.extend({
  messageId: z.string(),
  offset: z.number().int().nonnegative(),
  fingerprint: z.string()
}).strict()

export function queueCursor(
  value: z.infer<typeof PageCursor> | z.infer<typeof BodyCursor>
): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodedCursor(cursor: string): unknown {
  if (cursor.length > 16 * 1024) {
    return null
  }
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

export function readQueuePageCursor(cursor: string) {
  const parsed = PageCursor.safeParse(decodedCursor(cursor))
  return parsed.success ? parsed.data : null
}

export function readQueueBodyCursor(cursor: string) {
  const parsed = BodyCursor.safeParse(decodedCursor(cursor))
  return parsed.success ? parsed.data : null
}
