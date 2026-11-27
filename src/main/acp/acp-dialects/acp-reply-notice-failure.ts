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
  notice: Pick<RegExp, 'test'>,
  cause: Pick<AcpTurnEnding, 'notSignedIn'> = {},
  /** A readable sentence for the notice, its raw words then kept under Details, and any cause
   *  the words name (a usage limit). */
  readable?: (
    notice: string
  ) =>
    | Partial<Pick<AcpTurnEnding, 'failureDetail' | 'failureFrame' | 'stopReason' | 'usageLimit'>>
    | undefined
): AcpDialectNotification | undefined {
  const text =
    method === 'session/update'
      ? replyTextSchema.safeParse(params).data?.update.content.text
      : undefined
  if (!text || !notice.test(text)) {
    return undefined
  }
  const words = readable?.(text.trim()) ?? { failureDetail: text.trim() }
  return { disposition: 'map', failure: { stopReason: 'error', ...cause, ...words } }
}
