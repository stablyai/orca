// Why a chat's request failed, read once from its saved journal rows: worker escalations and bot senders say the same.

import { performance } from 'node:perf_hooks'
import { structuredAgentSessionStartFailure } from '../../../../native-chat/agent-session-wire/startup/structured-agent-session-failure-text'
import { agentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../shared/agent-session/failures/agent-session-failure-words'
import type { StructuredAgentSessionRequestFailure } from '../../../../native-chat/agent-session-wire/observations/structured-agent-session-request-failures'
import { tuiAgentDisplayName } from '../../../../../shared/agent-launch/catalog/tui-agent-display-names'
import { chatRequestError, type ChatRequestError } from './chat-worker-error-words'

/** Call synchronously from the failure event: pending output is captured before the first await.
 *  Null when the conversation is gone or was replaced. */
export async function readChatRequestError(
  request: StructuredAgentSessionRequestFailure
): Promise<ChatRequestError | null> {
  const deadline = performance.now() + 2_000
  const pending = request.death ? undefined : request.capturePendingOutput?.()
  // Settlement publication and promise continuations precede the ordered error read.
  await new Promise((resolve) => setImmediate(resolve))
  while (pending?.()) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)))
  }
  const snapshot = await request.read()
  if (snapshot === undefined) {
    return unrecordedChatRequestError(request)
  }
  if (snapshot === null) {
    return null
  }
  const recorded = chatRequestError(snapshot, request)
  return request.death &&
    (request.death.duringStartup ||
      !recorded ||
      (recorded.kind === 'providerExited' && !recorded.detail))
    ? unrecordedChatRequestError(request)
    : (recorded ?? { ...unrecordedChatRequestError(request), detail: undefined })
}

export function unrecordedChatRequestError(
  request: StructuredAgentSessionRequestFailure
): ChatRequestError {
  const agentName = tuiAgentDisplayName(request.agent) ?? 'The agent'
  const fact = request.death?.failure ?? agentSessionFailureFact('providerExited')
  const context = { agentName, ...request.death }
  const words = request.death?.duringStartup
    ? structuredAgentSessionStartFailure({ exit: fact }, context)
    : {
        reason: agentSessionFailureWords(fact, { ...context, surface: 'row' }).text,
        rejection: fact
      }
  return request.outcome === 'interruption'
    ? { text: words.reason, kind: words.rejection.kind, detail: fact.detail?.text }
    : { text: `${agentName} ended its turn with an error and recorded no message.` }
}
