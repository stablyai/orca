// What `orca bot reply` says when the host refuses it, and how long it waits for an answer.
import { RuntimeClientError } from '../runtime/connection/types'
import { CONNECTOR_REPLY_UNAVAILABLE } from '../../shared/rpc-contract/connectors/connector-params'

// The host retries an unavailable cloud itself, waiting out Retry-After, so the call can take a while.
export const REPLY_TIMEOUT_MS = 180_000

// A host that can't post for anyone: connectors off or signed out.
const REPLY_UNAVAILABLE_CODES = new Set(['connector_not_connected', 'connectors_disabled'])

// Each says what was true and what to do instead; a Home chat or automation run is the common case.
const REPLY_REFUSALS: Readonly<Record<string, string>> = {
  not_a_cloud_conversation:
    "Nothing was posted: this chat isn't attached to a Slack, GitHub, Linear or Discord thread on this host. A reply works only in a conversation someone started by messaging the bot there, or an event's run that answers in its thread. Your Home chat has none, and an automation run has one only when its results go to the event's thread (--results-to thread); put it in your final message, which goes wherever this chat's results go.",
  bot_chat_reply:
    "Nothing was posted: this is your Chat, which answers whichever direct message wrote last. A turn a direct message started posts your final message there when you finish. A turn that started on its own stays in Orca: to answer the direct message a worker start came from, use the --to that Orca's note on that start named.",
  not_a_saved_dm:
    "Nothing was posted: --to works only in your Chat, for the direct message Orca's note on a worker start there named, and only until anyone else's message reaches your Chat (then, or after Orca restarts, it is gone). Your final message stays in Orca.",
  not_this_bots_conversation:
    "Nothing was posted: this chat's conversation doesn't belong to this bot."
}

export function refusalOf(error: unknown): never {
  if (error instanceof RuntimeClientError && REPLY_UNAVAILABLE_CODES.has(error.code)) {
    throw new RuntimeClientError('not_a_cloud_conversation', CONNECTOR_REPLY_UNAVAILABLE)
  }
  const refusal = error instanceof RuntimeClientError && REPLY_REFUSALS[error.code]
  if (refusal) {
    throw new RuntimeClientError(error.code, refusal)
  }
  throw error
}
