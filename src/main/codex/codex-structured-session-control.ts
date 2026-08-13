import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionSetOptionInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  isCodexAppServerRequestError,
  type CodexAppServerServerRequest
} from './codex-app-server-connection'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'
import { answerCodexPrompt } from './codex-structured-prompt-replies'
import {
  applyCodexStructuredSessionOption,
  readLiveCodexSessionOptions
} from './codex-structured-session-options'
import type {
  CodexSession,
  CodexStructuredSessionAdapterDeps,
  CodexStructuredSessionEvent
} from './codex-structured-session-state'
import {
  deliverCodexNotification,
  deliverCodexServerRequest,
  deliverCodexUnhandledFrame
} from './codex-structured-provider-events'
import { dispatchCodexTurn, isCodexTurnOptionKey } from './codex-structured-turn-start'

const MAX_STRUCTURED_WRITE_REQUEST_BYTES = 1024 * 1024

/** Turn, prompt, and option traffic for already-published Codex children. */
export class CodexStructuredSessionControl {
  constructor(
    private readonly sessions: Map<string, CodexSession>,
    private readonly deps: CodexStructuredSessionAdapterDeps
  ) {}

  handleNotification = (sessionId: string, method: string, params: unknown): void => {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }
    this.deps.writeAuthority?.observeNotification(sessionId, method, params)
    deliverCodexNotification(sessionId, session, method, params, (current, event) =>
      this.emit(current, event)
    )
  }

  handleServerRequest = async (
    sessionId: string,
    request: CodexAppServerServerRequest
  ): Promise<void> => {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }
    if (this.deps.writeAuthority) {
      const reviewed = await this.deps.writeAuthority.reviewServerRequest(
        sessionId,
        request.method,
        request.params
      )
      if (reviewed.handled) {
        session.connection.respond(request.id, reviewed.result)
        return
      }
      session.connection.respondWithError(
        request.id,
        -32601,
        `structured-writer mode does not permit ${request.method}`
      )
      return
    }
    deliverCodexServerRequest(sessionId, session, request, (current, event) =>
      this.emit(current, event)
    )
  }

  handleUnhandledFrame = (sessionId: string, kind: string, payload: unknown): void => {
    deliverCodexUnhandledFrame(
      sessionId,
      this.sessions.get(sessionId),
      kind,
      payload,
      (session, event) => this.emit(session, event)
    )
  }

  bindPromptItemId = (sessionId: string, journalItemId: string, promptKey: string): void =>
    this.sessions
      .get(sessionId)
      ?.prompts.bindJournalItemId(journalItemId, this.session(sessionId).threadId, promptKey)

  dispatch = async (input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    fence: number
    requestAuthority?: {
      effectAuthority: 'local_structured_write'
      requestReceiptId: string
    }
  }): Promise<AgentSessionDispatchOutcome> => {
    const authority = this.deps.writeAuthority
    if (input.requestAuthority && !authority) {
      return {
        state: 'rejected',
        reason: 'local structured write is not enabled on this execution host'
      }
    }
    let dispatchInput = input
    if (authority) {
      try {
        dispatchInput = snapshotStructuredWriterInput(input)
      } catch (error) {
        authority.invalidateForNewTurn(input.sessionId)
        return {
          state: 'rejected',
          reason: error instanceof Error ? error.message : String(error)
        }
      }
    }
    const turnEpoch = authority ? await authority.openTurn(dispatchInput) : null
    const outcome = await dispatchCodexTurn(
      this.session(dispatchInput.sessionId),
      dispatchInput,
      this.deps.requestTimeoutMs,
      authority
        ? {
            approvalPolicy: 'on-request',
            approvalsReviewer: 'user',
            sandboxPolicy: { type: 'readOnly', networkAccess: false }
          }
        : undefined
    )
    if (
      authority &&
      turnEpoch !== null &&
      outcome.state === 'accepted' &&
      outcome.providerIdentity.provider === 'codex'
    ) {
      authority.bindTurn(
        input.sessionId,
        outcome.providerIdentity.threadId,
        outcome.providerIdentity.turnId,
        turnEpoch
      )
    } else if (authority) {
      authority.revokePendingTurn(input.sessionId)
    }
    return outcome
  }

  cancelTurn = async (input: {
    sessionId: string
    turnId: string
    fence: number
  }): Promise<{ cancelled: boolean }> => {
    const session = this.session(input.sessionId)
    this.deps.writeAuthority?.revokePendingTurn(input.sessionId)
    try {
      await session.connection.request(
        'turn/interrupt',
        { threadId: session.threadId, turnId: input.turnId },
        { timeoutMs: this.deps.requestTimeoutMs }
      )
      return { cancelled: true }
    } catch (error) {
      if (isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error)) {
        return { cancelled: false }
      }
      throw error
    }
  }

  answerPrompt = async (input: {
    sessionId: string
    itemId: string
    kind: 'approval' | 'question'
    optionId: string
    fence: number
  }): Promise<void> => {
    const session = this.session(input.sessionId)
    answerCodexPrompt(session.prompts, session.connection, input.itemId, input.optionId)
  }

  setOption = async (
    input: StructuredAgentSessionSetOptionInput
  ): Promise<Readonly<Record<string, string>>> => {
    if (!isCodexTurnOptionKey(input.key)) {
      throw new Error(`codex app-server has no thread option named ${input.key}`)
    }
    return applyCodexStructuredSessionOption(
      this.session(input.sessionId),
      input.key,
      input.value,
      this.deps.requestTimeoutMs
    )
  }

  readOptions = (input: { sessionId: string; fence: number }) =>
    readLiveCodexSessionOptions(this.session(input.sessionId), this.deps.requestTimeoutMs)

  historyFilePath = async (input: {
    identity: AgentSessionJournalIdentity
  }): Promise<string | null> => this.sessions.get(input.identity.sessionId)?.historyPath ?? null

  emit(session: CodexSession, event: CodexStructuredSessionEvent): void {
    session.translator?.handle(event)
    this.deps.onEvent?.(event)
  }

  private session(sessionId: string): CodexSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`no live codex app-server for session ${sessionId}`)
    }
    return session
  }
}

function snapshotStructuredWriterInput(input: {
  sessionId: string
  clientMessageId: string
  body: AgentJournalMessageItem
  fence: number
  requestAuthority?: {
    effectAuthority: 'local_structured_write'
    requestReceiptId: string
  }
}): typeof input {
  const body = structuredClone(input.body)
  const requestAuthority = input.requestAuthority ? { ...input.requestAuthority } : undefined
  let requestBytes = 0
  let hasText = false
  if (body.role !== 'user') {
    throw new Error('structured writer accepts only a direct user message')
  }
  for (const block of body.blocks) {
    if (block.type !== 'text') {
      throw new Error('structured writer accepts only text request blocks')
    }
    requestBytes += Buffer.byteLength(block.text)
    hasText ||= block.text.length > 0
  }
  if (!hasText || requestBytes > MAX_STRUCTURED_WRITE_REQUEST_BYTES) {
    throw new Error('structured writer request is empty or too large')
  }
  if (
    requestAuthority &&
    (!/^[0-9a-f]{64}$/.test(requestAuthority.requestReceiptId) ||
      requestAuthority.effectAuthority !== 'local_structured_write')
  ) {
    throw new Error('structured writer request authority is invalid')
  }
  return { ...input, body, ...(requestAuthority ? { requestAuthority } : {}) }
}
