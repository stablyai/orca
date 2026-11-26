// `orca bot reply --to`: a bot's Chat answers the direct message a worker start there saved.
import { randomUUID } from 'node:crypto'
import type { HandlerContext } from '../dispatch/dispatch'
import { getOptionalStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { formatReply, type ConnectorReply } from './bot-reply-format'
import { REPLY_TIMEOUT_MS, refusalOf } from './bot-reply-refusals'

/** Its own method, so a host that predates it refuses rather than post in the chat's current DM. */
export async function replySavedDm(
  { flags, client, json }: Pick<HandlerContext, 'flags' | 'client' | 'json'>,
  {
    sessionId,
    text,
    rest
  }: { sessionId: string | undefined; text: string | undefined; rest: boolean }
): Promise<void> {
  const to = getOptionalStringFlag(flags, 'to')
  if (!to || !text || rest) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--to takes the direct message Orca named and --text, and nothing else.'
    )
  }
  if (!sessionId) {
    throw new RuntimeClientError('invalid_argument', "--to works only in a bot's Chat.")
  }
  const posted = await client
    .call<ConnectorReply>(
      'connector.replySavedDm',
      { sessionId, replyId: randomUUID(), text, to },
      { timeoutMs: REPLY_TIMEOUT_MS }
    )
    .catch((error: unknown) => {
      if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
        throw new RuntimeClientError(
          'not_a_saved_dm',
          "Nothing was posted: this Orca can't post with --to yet. Update Orca; your final message stays in Orca."
        )
      }
      return refusalOf(error)
    })
  printResult(posted, json, (value) => formatReply(value))
}
