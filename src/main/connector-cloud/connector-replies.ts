import { delayUnlessAborted } from '../../shared/concurrency/abort-aware-delay'
import type { z } from 'zod'
import {
  CONNECTOR_PATHS,
  ConnectorBotPostResponse,
  ConnectorReplyResponse,
  type ConnectorBotPostAnswer,
  type ConnectorConversation,
  type ConnectorTurnFor
} from '../../shared/connectors/connector-cloud-contract'
import {
  CONNECTOR_ACTIONS_PATH,
  ConnectorActionResponse
} from '../../shared/connector-action-contract'
import type { ConnectorReview } from '../../shared/connector-review-contract'
import { connectorReviewText } from '../../shared/connector-review-text'
import type { ConnectorResult } from './connector-cloud-request'
import type { ConnectorTransport } from './connector-machine'
import { connectorRetryDelayMs } from './connector-outbox'

const REPLY_ATTEMPTS = 3
// A longer Retry-After fails the reply rather than holding the agent's command.
const MAX_REPLY_WAIT_MS = 60_000

export type ConnectorReplyBody = {
  replyId: string
  conversation: ConnectorConversation
  turnId: number
  text: string
  review?: ConnectorReview
  // Whom the turn acts for when no delivery started it (bot-turn-for.ts).
  turnFor?: ConnectorTurnFor
  /** The delivery whose answer this is, sent only to a cloud that lists replies.outbox. */
  answerDeliveryId?: string
}

/** For a cloud that takes no review. */
export function foldConnectorReview(body: ConnectorReplyBody): ConnectorReplyBody {
  const { review, ...rest } = body
  return review ? { ...rest, text: connectorReviewText(body.text, review) } : body
}

/** Retries an unreachable or busy cloud with the same idempotency key, which never posts twice, and
 *  the usual backoff. */
export async function postWithRetries<TSchema extends z.ZodType>(
  transport: ConnectorTransport,
  call: { path: string; body: unknown; schema: TSchema },
  signal: AbortSignal,
  random: () => number
): Promise<ConnectorResult<z.infer<TSchema>>> {
  for (let failures = 0; ; failures++) {
    const sent = await transport.call(call.path, call.body, call.schema, { signal })
    const retryable =
      !sent.ok && (sent.status === null || sent.status === 429 || sent.status >= 500)
    if (!retryable || failures + 1 >= REPLY_ATTEMPTS) {
      return sent
    }
    const waitMs = connectorRetryDelayMs(failures, sent, random)
    if (waitMs > MAX_REPLY_WAIT_MS || signal.aborted) {
      return sent
    }
    await delayUnlessAborted(waitMs, signal)
  }
}

export function postConnectorReply(
  transport: ConnectorTransport,
  body: ConnectorReplyBody,
  signal: AbortSignal,
  random: () => number
): Promise<ConnectorResult<ConnectorReplyResponse>> {
  return postWithRetries(
    transport,
    { path: CONNECTOR_PATHS.replies, body: { v: 1, ...body }, schema: ConnectorReplyResponse },
    signal,
    random
  )
}

/** A message a bot posts on its own, in a Slack channel or as a Linear issue comment; one postId posts once. */
// turnFor: whom the run behind it acts for (bot-turn-for.ts); a Slack post's only.
export type ConnectorBotPostBody =
  | { postId: string; channelId: string; text: string; turnFor?: ConnectorTurnFor }
  | { postId: string; issue: string; text: string }
  // A place by ref, posted through the actions route; only to a cloud that takes refs.
  | { postId: string; ref: string; text: string; turnFor?: ConnectorTurnFor }

export async function postConnectorBotMessage(
  transport: ConnectorTransport,
  botId: string,
  body: ConnectorBotPostBody,
  signal: AbortSignal,
  random: () => number = Math.random
): Promise<ConnectorResult<ConnectorBotPostAnswer>> {
  if ('ref' in body) {
    // The actions route's post, queued once per postId as the bot's other posts are.
    const { postId, ref, text, turnFor } = body
    const answer = await postWithRetries(
      transport,
      {
        path: CONNECTOR_ACTIONS_PATH,
        body: {
          v: 1,
          botId,
          verb: 'post',
          ref,
          args: { text, postId },
          ...(turnFor ? { turnFor } : {})
        },
        schema: ConnectorActionResponse
      },
      signal,
      random
    )
    if (!answer.ok || answer.value.ok) {
      const listed: unknown = answer.ok && answer.value.ok ? answer.value.result.notices : undefined
      const notices = Array.isArray(listed)
        ? listed.filter((notice): notice is string => typeof notice === 'string')
        : []
      return answer.ok ? { ok: true, value: notices.length > 0 ? { notices } : undefined } : answer
    }
    return { ok: false, status: 409, error: answer.value.refusal, retryAfterMs: null }
  }
  return await postWithRetries(
    transport,
    {
      path: `${CONNECTOR_PATHS.bots}/${encodeURIComponent(botId)}/${'issue' in body ? 'linear/comments' : 'posts'}`,
      body: { v: 1, ...body },
      schema: ConnectorBotPostResponse
    },
    signal,
    random
  )
}
