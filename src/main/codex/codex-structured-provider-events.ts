import type { CodexAppServerServerRequest } from './codex-app-server-connection'
import { disposeCodexServerRequest } from './codex-server-request-disposition'
import type { CodexSession, CodexStructuredSessionEvent } from './codex-structured-session-state'
import { readCodexThreadId, readCodexTurnId } from './codex-structured-thread-facts'

type EmitCodexEvent = (session: CodexSession, event: CodexStructuredSessionEvent) => void

export function deliverCodexNotification(
  sessionId: string,
  session: CodexSession | undefined,
  method: string,
  params: unknown,
  emit: EmitCodexEvent
): void {
  if (!session) {
    return
  }
  const threadId = readCodexThreadId(params) ?? session.threadId
  if (method === 'turn/started' && threadId === session.threadId) {
    const turnId = readCodexTurnId(params)
    const waiter = turnId ? session.turnIdWaiters.shift() : undefined
    waiter?.(turnId as string)
  }
  emit(session, { type: 'notification', sessionId, threadId, method, params })
}

export function deliverCodexServerRequest(
  sessionId: string,
  session: CodexSession | undefined,
  request: CodexAppServerServerRequest,
  emit: EmitCodexEvent
): void {
  if (!session) {
    return
  }
  const disposition = disposeCodexServerRequest(session.prompts, session.connection, request)
  const threadId = readCodexThreadId(request.params) ?? session.threadId
  if (disposition.kind === 'responded') {
    emit(session, {
      type: 'server-request',
      sessionId,
      threadId,
      method: request.method,
      params: request.params
    })
    return
  }
  const prompt = disposition.prompt
  emit(session, {
    type: 'prompt',
    sessionId,
    threadId: prompt.threadId,
    method: request.method,
    params: request.params,
    codexItemId: prompt.codexItemId,
    promptKey: prompt.promptKey
  })
}

export function deliverCodexUnhandledFrame(
  sessionId: string,
  session: CodexSession | undefined,
  kind: string,
  payload: unknown,
  emit: EmitCodexEvent
): void {
  if (!session) {
    return
  }
  emit(session, {
    type: 'provider-frame',
    sessionId,
    threadId: readCodexThreadId(payload) ?? session.threadId,
    kind,
    payload
  })
}
