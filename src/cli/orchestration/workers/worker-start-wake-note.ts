// A worker start's note on where it came from, for a later turn that starts on its own (the start
// finished in the background) and so posts nothing by itself. The bot decides whether to post.
import { readInjectedAgentSessionId } from '../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import type { RuntimeClient } from '../../runtime/client'
import { orchestrationCliName } from '../agent-view'

type WakeReplyPlace = { place: string | null; to?: string }

const WAKE_NOTE_TIMEOUT_MS = 5_000

/** Null outside a bot chat, from a host that predates it, or when Orca can't prove the place. */
export async function readWorkerStartWakeNote(client: RuntimeClient): Promise<string | null> {
  const sessionId = readInjectedAgentSessionId()
  if (!sessionId) {
    return null
  }
  // Optional, so a host slow to answer never holds the start back for long.
  const answer = await client
    .call<WakeReplyPlace>(
      'connector.wakeReplyPlace',
      { sessionId },
      { timeoutMs: WAKE_NOTE_TIMEOUT_MS }
    )
    .catch(() => null)
  const found = answer?.result
  return found?.place ? formatWorkerStartWakeNote(found.place, found.to) : null
}

export function formatWorkerStartWakeNote(
  place: string,
  to?: string,
  cli = orchestrationCliName()
): string {
  const post = to
    ? `${cli} bot reply --to ${to} --text "..." posts in that direct message, until anyone else's message reaches this chat`
    : `${cli} bot reply --text "..." posts there`
  return `[Orca: this start came from ${place}. A turn that starts on its own when this command finishes in the background stays in Orca; ${post}.]`
}
