// `orca bot reply --leave-thread`: the bot stops being woken in its Slack thread until someone
// @mentions it. Orca checks who asked and posts the confirmation; this only says how it went.
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import type { HandlerContext } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'

const LEAVE_TIMEOUT_MS = 60_000
const REPLY_FLAGS = ['text', 'text-file', 'note', 'file', 'choice', 'react']

export async function leaveThread({
  client,
  flags,
  json
}: Pick<HandlerContext, 'client' | 'flags' | 'json'>): Promise<void> {
  if (REPLY_FLAGS.some((flag) => flags.has(flag))) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use --leave-thread on its own: post anything else in its own reply first.'
    )
  }
  const sessionId = readInjectedAgentSessionId()
  if (!sessionId) {
    throw new RuntimeClientError('invalid_argument', "--leave-thread works only in a bot's chat.")
  }
  const left = await client
    .call<{ ok: true; already?: true }>(
      'connector.leaveThread',
      { sessionId },
      { timeoutMs: LEAVE_TIMEOUT_MS }
    )
    .catch((error: unknown) => {
      // The host may have left after the wait ran out; its line in the thread says so if it did.
      if (error instanceof RuntimeClientError && error.code === 'runtime_timeout') {
        throw new RuntimeClientError(
          'leave_unconfirmed',
          "Orca couldn't confirm whether you left; Orca posts a confirmation in the thread if it did."
        )
      }
      throw error
    })
  printResult(left, json, (value) =>
    value.already
      ? "You'd already left this thread."
      : "Left this thread. Orca will post the confirmation; don't repeat it."
  )
}
