// One status line's post as Orca's own reply, and what its answer means for the next try.
import type { ConnectorConversation } from '../../../shared/connectors/connector-cloud-contract'
import type { ThreadStatusFact } from '../../../shared/connectors/external-conversation-link'
import type { ThreadStatusCloud } from './thread-status-deps'

// Refusals no retry lifts: the line is dropped and the thread's lines stop.
const NEVER_STATUS = new Set([400, 403, 404, 413, 422])
const NEVER_ERRORS = new Set(['reply_not_accepted', 'not_this_hosts_thread'])
const CONFLICT_ERRORS = new Set(['reply_id_conflict', 'reply_undeliverable'])

/** `later`: busy, offline or no client; the same line goes again at the next tick, or once the
 *  cloud's Retry-After has passed. */
export type ThreadStatusSent =
  | { kind: 'sent' | 'never' | 'conflict' }
  | { kind: 'later'; retryAfterMs: number | null }

const LATER: ThreadStatusSent = { kind: 'later', retryAfterMs: null }

export async function sendThreadStatusLine(
  cloud: ThreadStatusCloud,
  conversation: ConnectorConversation,
  pending: NonNullable<ThreadStatusFact['pending']>,
  proceed: () => boolean
): Promise<ThreadStatusSent> {
  const replying = cloud.reply(
    {
      replyId: pending.replyId,
      conversation,
      turnId: pending.at,
      text: pending.text,
      // Orca's own line, on no one's behalf: no bot hears it as a person's request.
      turnFor: 'none'
    },
    proceed
  )
  const sent = replying ? await replying.catch(() => null) : null
  if (sent === null) {
    return LATER
  }
  if (sent.ok) {
    return { kind: 'sent' }
  }
  if (
    (sent.status !== null && NEVER_STATUS.has(sent.status)) ||
    (sent.error !== null && NEVER_ERRORS.has(sent.error))
  ) {
    return { kind: 'never' }
  }
  if (sent.status === 409 && sent.error !== null && CONFLICT_ERRORS.has(sent.error)) {
    return { kind: 'conflict' }
  }
  return { kind: 'later', retryAfterMs: sent.retryAfterMs ?? null }
}
