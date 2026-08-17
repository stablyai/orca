import { randomUUID } from 'node:crypto'
import type { HarnessConversationDriverSink } from './driver'
import { completeAcpReasoning, completeAcpResponse, type AcpTextState } from './acp-message'

const GROK_RESPONSE_METHODS = [
  'x.ai/session_notification',
  'x.ai/session/update',
  '_x.ai/session/update'
]

export function observeGrokResponseBoundary(
  method: string,
  params: Record<string, unknown>,
  sessionId: string | null,
  sink: HarnessConversationDriverSink,
  texts: AcpTextState,
  fallbackMessageId: string
): string {
  if (!GROK_RESPONSE_METHODS.includes(method) || (sessionId && params.sessionId !== sessionId)) {
    return fallbackMessageId
  }
  const update = params.update as Record<string, unknown> | undefined
  if (update?.sessionUpdate === 'response_started') {
    return typeof update.message_id === 'string' ? update.message_id : randomUUID()
  }
  if (update?.sessionUpdate !== 'response_completed') {
    return fallbackMessageId
  }
  completeAcpReasoning(sink, texts)
  completeAcpResponse(
    sink,
    texts,
    fallbackMessageId,
    update.stop_reason === 'end_turn' ? undefined : 'commentary'
  )
  return randomUUID()
}
