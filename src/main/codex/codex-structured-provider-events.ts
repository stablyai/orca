import type { CodexAppServerServerRequest } from './codex-app-server-connection'
import { disposeCodexServerRequest } from './codex-server-request-disposition'
import type { CodexJournalTranslationAdmission } from './codex-structured-journal-translation'
import type { CodexSession, CodexStructuredSessionEvent } from './codex-structured-session-state'
import { readCodexThreadId, readCodexTurnId } from './codex-structured-thread-facts'

type EmitCodexEvent = (
  session: CodexSession,
  event: CodexStructuredSessionEvent
) => CodexJournalTranslationAdmission

export function deliverCodexNotification(
  sessionId: string,
  session: CodexSession | undefined,
  method: string,
  params: unknown,
  emit: EmitCodexEvent
): CodexJournalTranslationAdmission {
  if (!session) {
    return { accepted: true }
  }
  const threadId = readCodexThreadId(params) ?? session.threadId
  const turnId =
    method === 'turn/started' && threadId === session.threadId ? readCodexTurnId(params) : null
  const turnWaiter = turnId ? session.turnIdWaiters[0] : undefined
  const admission = emit(session, { type: 'notification', sessionId, threadId, method, params })
  if (method === 'turn/started' && threadId === session.threadId) {
    if (admission.accepted && turnId && session.turnIdWaiters[0] === turnWaiter) {
      session.turnIdWaiters.shift()
      turnWaiter?.(turnId)
    }
  }
  return admission
}

export function deliverCodexServerRequest(
  sessionId: string,
  session: CodexSession | undefined,
  request: CodexAppServerServerRequest,
  emit: EmitCodexEvent
): CodexJournalTranslationAdmission {
  if (!session) {
    return { accepted: true }
  }
  const disposition = disposeCodexServerRequest(session.prompts, session.connection, request)
  const threadId = readCodexThreadId(request.params) ?? session.threadId
  if (disposition.kind === 'responded') {
    const admission = emit(session, {
      type: 'server-request',
      sessionId,
      threadId,
      method: request.method,
      params: request.params
    })
    if (!admission.accepted) {
      void session.forceCloseUnexpected?.(
        new Error(
          `Codex server request ${request.method} could not be durably recorded (${admission.reason})`
        )
      )
    }
    return admission
  }
  const prompt = disposition.prompt
  const admission = emit(session, {
    type: 'prompt',
    sessionId,
    threadId: prompt.threadId,
    method: request.method,
    params: request.params,
    codexItemId: prompt.codexItemId,
    promptKey: prompt.promptKey
  })
  if (!admission.accepted) {
    session.prompts.forget(prompt)
    session.connection.respondWithError(
      request.id,
      -32001,
      `Orca could not durably record ${request.method} prompt (${admission.reason})`
    )
  }
  return admission
}

export function deliverCodexUnhandledFrame(
  sessionId: string,
  session: CodexSession | undefined,
  kind: string,
  payload: unknown,
  emit: EmitCodexEvent
): CodexJournalTranslationAdmission {
  if (!session) {
    return { accepted: true }
  }
  const admission = emit(session, {
    type: 'provider-frame',
    sessionId,
    threadId: readCodexThreadId(payload) ?? session.threadId,
    kind,
    payload
  })
  if (!admission.accepted) {
    // There is no safe replay cursor for malformed/unhandled frames. Close the
    // provider so host recovery records a truthful terminal failure instead of
    // silently dropping the diagnostic under sink backpressure.
    void session.forceCloseUnexpected?.(
      new Error(`Codex provider frame ${kind} could not be durably recorded (${admission.reason})`)
    )
  }
  return admission
}
