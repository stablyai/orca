import { z } from 'zod'
import type { AcpDialectNotification, AcpTurnEnding } from './acp-dialect'

// Reads only these fields, so the many tool updates of a turn are rejected at the literal.
const replyTextSchema = z.object({
  update: z.object({
    sessionUpdate: z.literal('agent_message_chunk'),
    content: z.object({ type: z.literal('text'), text: z.string() })
  })
})

/** A reply chunk that is wholly the agent's own failure notice fails the turn in its place. */
export function acpReplyNoticeFailure(
  method: string,
  params: unknown,
  notice: RegExp,
  cause: Pick<AcpTurnEnding, 'notSignedIn'> = {}
): AcpDialectNotification | undefined {
  const text =
    method === 'session/update'
      ? replyTextSchema.safeParse(params).data?.update.content.text
      : undefined
  return text && notice.test(text)
    ? { disposition: 'map', failure: { stopReason: 'error', ...cause, failureDetail: text.trim() } }
    : undefined
}
