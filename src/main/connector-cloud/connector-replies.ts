import { delayUnlessAborted } from '../../shared/abort-aware-delay'
import {
  CONNECTOR_PATHS,
  ConnectorReplyResponse,
  type ConnectorConversation
} from '../../shared/connector-cloud-contract'
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
}

/** Retries an unreachable or busy cloud with the same replyId, which never posts twice, and the usual backoff. */
export async function postConnectorReply(
  transport: ConnectorTransport,
  body: ConnectorReplyBody,
  signal: AbortSignal,
  random: () => number
): Promise<ConnectorResult<ConnectorReplyResponse>> {
  for (let failures = 0; ; failures++) {
    const sent = await transport.call(
      CONNECTOR_PATHS.replies,
      { v: 1, ...body },
      ConnectorReplyResponse,
      {
        signal
      }
    )
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
