import type { CodexAppServerServerRequest } from './codex-app-server-connection'
import {
  codexAsyncPartialAnswerText,
  readCodexAsyncQuestionRequest,
  readCodexUserMessageReply,
  type CodexAsyncQuestionRequest
} from './codex-async-user-input'
import { CODEX_USER_INPUT_METHOD, type CodexPendingPrompt } from './codex-prompt-registry'
import { disposeCodexServerRequest } from './codex-server-request-disposition'
import type { CodexJournalTranslationAdmission } from './codex-structured-journal-translation'
import * as codexRewind from './codex-structured-rewind'
import type { CodexSession, CodexStructuredSessionEvent } from './codex-structured-session-state'
import { readCodexThreadId } from './codex-structured-thread-facts'
import { readCodexTurnEnd } from './codex-structured-turn-end-settlement'
import { steerCodexTurn } from './codex-structured-turn-start'

type EmitCodexEvent = (
  session: CodexSession,
  event: CodexStructuredSessionEvent
) => CodexJournalTranslationAdmission

/** One live notification's journal entry: rewind bookkeeping, delivery. */
export function translateCodexNotification(input: {
  sessionId: string
  session: CodexSession
  method: string
  params: unknown
  observedAt?: number
  dispatchSequenceAtReceipt?: number
  emit: EmitCodexEvent
  requestTimeoutMs?: number
}): CodexJournalTranslationAdmission {
  const { sessionId, session, method, params, observedAt, dispatchSequenceAtReceipt } = input
  codexRewind.observeCodexRewindActivity(session, method, params)
  session.turnOpenWaits.observe(session.threadId, method, params)
  const admission = deliverCodexNotification(
    sessionId,
    session,
    method,
    params,
    input.emit,
    observedAt,
    dispatchSequenceAtReceipt
  )
  if (!admission.accepted) {
    return admission
  }
  const threadId = readCodexThreadId(params) ?? session.threadId
  if (readCodexUserMessageReply(method, params)) {
    for (const answered of session.prompts.forgetAsync(threadId)) {
      steerCodexPartialAnswers(session, answered, input.requestTimeoutMs)
    }
  }
  const abandoned = session.prompts.takeAbandonedAsyncAnswers()
  // Codex 0.158 ends a turn on its own while an async ask waits; a Stop or failure is not resumed.
  if (readCodexTurnEnd(method, params)?.status === 'completed') {
    for (const answered of abandoned) {
      steerCodexPartialAnswers(session, answered, input.requestTimeoutMs)
    }
  }
  const asked = readCodexAsyncQuestionRequest(threadId, method, params)
  return asked ? deliverCodexAsyncQuestion(sessionId, session, asked, input.emit) : admission
}

/** The journal already shows these card answers as resolved, so Codex must still receive them
 *  after the typed reply or turn end that closed the ask. */
function steerCodexPartialAnswers(
  session: CodexSession,
  prompt: CodexPendingPrompt,
  timeoutMs: number | undefined
): void {
  const text = codexAsyncPartialAnswerText(prompt)
  if (!text) {
    return
  }
  steerCodexTurn(session.connection, { threadId: prompt.threadId, text, timeoutMs }).catch(
    (error: unknown) => {
      console.warn('[codex] could not deliver answered async question cards', error)
    }
  )
}

/** Registers an async ask as a question prompt so it renders, and is answered, like a blocking one. */
function deliverCodexAsyncQuestion(
  sessionId: string,
  session: CodexSession,
  asked: CodexAsyncQuestionRequest,
  emit: EmitCodexEvent
): CodexJournalTranslationAdmission {
  const prompt = session.prompts.register(
    { id: asked.itemId, method: CODEX_USER_INPUT_METHOD, params: asked.params },
    'async'
  )
  if (!prompt) {
    // Unmodelable within bounds: the agent message row still shows the question.
    return { accepted: true }
  }
  const admission = emit(session, {
    type: 'prompt',
    sessionId,
    threadId: prompt.threadId,
    method: CODEX_USER_INPUT_METHOD,
    params: asked.params,
    codexItemId: prompt.codexItemId,
    promptKey: prompt.promptKey,
    delivery: 'async'
  })
  if (!admission.accepted) {
    session.prompts.forget(prompt)
  }
  return admission
}

export function deliverCodexNotification(
  sessionId: string,
  session: CodexSession | undefined,
  method: string,
  params: unknown,
  emit: EmitCodexEvent,
  observedAt?: number,
  dispatchSequenceAtReceipt?: number
): CodexJournalTranslationAdmission {
  if (!session) {
    return { accepted: true }
  }
  const threadId = readCodexThreadId(params) ?? session.threadId
  // Dispatch identity settles on the user-message echo inside the translator,
  // which is where the ordinal a replay will compute is minted.
  return emit(session, {
    type: 'notification',
    sessionId,
    threadId,
    method,
    params,
    ...(observedAt !== undefined ? { observedAt } : {}),
    ...(dispatchSequenceAtReceipt !== undefined ? { dispatchSequenceAtReceipt } : {})
  })
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
