import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import {
  AgentSessionPreSpawnError,
  type AgentSessionAcquisition,
  type AgentSessionDispatchOutcome,
  type StructuredAgentSessionAcquireInput,
  type StructuredAgentSessionAdapter,
  type StructuredAgentSessionSetOptionInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import {
  isCodexAppServerRequestError,
  openCodexAppServerConnection
} from './codex-app-server-connection'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'
import { codexProcessIdentity, codexProviderHandleLink } from './codex-structured-owner-identity'
import { buildCodexStructuredChildEnvironment } from './codex-structured-child-environment'
import { answerCodexPrompt } from './codex-structured-prompt-replies'
import { openCodexThread } from './codex-structured-thread-open'
import { dispatchCodexTurn, isCodexTurnOptionKey } from './codex-structured-turn-start'
import { supportsCodexStructuredLocation } from './codex-structured-location-support'
import { closeCodexPublishedSession } from './codex-structured-session-close'
import {
  applyCodexStructuredSessionOption,
  readLiveCodexSessionOptions,
  reportedCodexThreadOptions,
  restoredCodexSessionOptions
} from './codex-structured-session-options'
import {
  cancelCodexAcquisitionAttempt,
  CodexAcquisitionRegistry,
  type CodexAcquisitionAttempt,
  type CodexSession,
  type CodexStructuredSessionAdapterDeps,
  type CodexStructuredSessionEvent
} from './codex-structured-session-state'
import {
  deliverCodexNotification,
  deliverCodexServerRequest,
  deliverCodexUnhandledFrame
} from './codex-structured-provider-events'

export type {
  CodexStructuredLaunch,
  CodexStructuredSessionAdapterDeps,
  CodexStructuredSessionEvent
} from './codex-structured-session-state'

export class CodexStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, CodexSession>()
  private readonly acquisitions = new CodexAcquisitionRegistry()

  constructor(private readonly deps: CodexStructuredSessionAdapterDeps) {}

  supportsLocation = supportsCodexStructuredLocation

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> {
    const sessionId = input.identity.sessionId
    const { previousAttempt, attempt } = this.acquisitions.start(sessionId)
    const acquisition = attempt.window
    let primaryThreadId =
      input.identity.providerHandle.kind === 'codex' ? input.identity.providerHandle.threadId : null
    const translator = input.events
      ? createCodexJournalTranslator({
          sink: input.events,
          primaryThreadId: () => primaryThreadId,
          bindPromptItemId: (journalItemId, threadId, promptKey) =>
            acquisition.prompts.bindJournalItemId(journalItemId, threadId, promptKey)
        })
      : null
    const open = this.deps.openConnection ?? openCodexAppServerConnection

    try {
      await cancelCodexAcquisitionAttempt(previousAttempt)
      this.acquisitions.assertCurrent(sessionId, attempt)
      await closeCodexPublishedSession(this.sessions, sessionId, this.deps.onEvent)
      this.acquisitions.assertCurrent(sessionId, attempt)
      const launch = await this.deps
        .resolveLaunch({ identity: input.identity })
        .catch((error: unknown) => {
          throw new AgentSessionPreSpawnError(error)
        })
      this.acquisitions.assertCurrent(sessionId, attempt)
      const connection = await open(
        {
          command: launch.command,
          args: launch.args,
          env: buildCodexStructuredChildEnvironment(launch, input.spawnToken)
        },
        {
          onNotification: (method, params) =>
            this.deliver(acquisition, sessionId, () =>
              this.handleNotification(sessionId, method, params)
            ),
          onServerRequest: (request) =>
            this.deliver(acquisition, sessionId, () =>
              this.handleServerRequest(sessionId, request)
            ),
          onUnhandledFrame: (kind, payload) =>
            this.deliver(acquisition, sessionId, () =>
              this.handleUnhandledFrame(sessionId, kind, payload)
            ),
          onExit: (error) => this.handleExit(sessionId, acquisition, error)
        }
      )
      acquisition.connection = connection
      this.acquisitions.assertCurrent(sessionId, attempt)
      const opened = await openCodexThread(connection, launch, this.deps.requestTimeoutMs)
      this.acquisitions.assertCurrent(sessionId, attempt)
      primaryThreadId = opened.threadId
      const process = await codexProcessIdentity(
        { ...input, pid: connection.pid },
        this.deps.readProcessStartTime
      )
      this.acquisitions.assertCurrent(sessionId, attempt)
      const acquired: AgentSessionAcquisition = {
        process,
        link: codexProviderHandleLink({
          threadId: opened.threadId,
          resumed: launch.resumeThreadId !== null,
          fence: input.fence,
          linkId: this.deps.mintLinkId?.(),
          observedAt: this.deps.now?.() ?? Date.now()
        })
      }
      // Publish only after every promised identity is proven and this attempt still owns the child.
      if (connection.closed) {
        throw new Error(`codex app-server for session ${sessionId} exited while being acquired`)
      }
      this.acquisitions.assertCurrent(sessionId, attempt)
      this.acquisitions.deleteIfCurrent(sessionId, attempt)
      this.sessions.set(sessionId, {
        connection,
        threadId: opened.threadId,
        historyPath: opened.historyPath,
        prompts: acquisition.prompts,
        options: restoredCodexSessionOptions(input.options),
        reportedOptions: reportedCodexThreadOptions(opened),
        turnIdWaiters: [],
        translator
      })
      for (const event of acquisition.drain()) {
        event()
      }
      return acquired
    } catch (error) {
      this.acquisitions.deleteIfCurrent(sessionId, attempt)
      // Reap this attempt's child only. A replacement already published for the
      // same session keeps running.
      if (this.sessions.get(sessionId)?.connection !== acquisition.connection) {
        translator?.dispose()
        await acquisition.connection?.close()
      }
      throw error
    } finally {
      attempt.finish()
    }
  }

  /** Buffers pre-publication events and drops events from superseded children. */
  private deliver(
    acquisition: CodexAcquisitionAttempt['window'],
    sessionId: string,
    event: () => void
  ): void {
    if (acquisition.buffer(event)) {
      return
    }
    if (this.sessions.get(sessionId)?.connection === acquisition.connection) {
      event()
    }
  }

  /** Only the current connection may retire a session. */
  private handleExit(
    sessionId: string,
    acquisition: CodexAcquisitionAttempt['window'],
    error: Error
  ): void {
    acquisition.prompts.clear()
    const session = this.sessions.get(sessionId)
    if (!session || session.connection !== acquisition.connection) {
      return
    }
    this.sessions.delete(sessionId)
    this.emit(session, { type: 'ended', sessionId, reason: error.message })
    session.translator?.dispose()
  }

  private handleNotification(sessionId: string, method: string, params: unknown): void {
    deliverCodexNotification(
      sessionId,
      this.sessions.get(sessionId),
      method,
      params,
      (session, event) => this.emit(session, event)
    )
  }

  /** Journal first so observers never see an event ahead of its durable row. */
  private emit(session: CodexSession, event: CodexStructuredSessionEvent): void {
    session.translator?.handle(event)
    this.deps.onEvent?.(event)
  }

  private handleServerRequest(
    sessionId: string,
    request: Parameters<typeof deliverCodexServerRequest>[2]
  ): void {
    deliverCodexServerRequest(sessionId, this.sessions.get(sessionId), request, (session, event) =>
      this.emit(session, event)
    )
  }

  private handleUnhandledFrame(sessionId: string, kind: string, params: unknown): void {
    deliverCodexUnhandledFrame(
      sessionId,
      this.sessions.get(sessionId),
      kind,
      params,
      (session, event) => this.emit(session, event)
    )
  }

  bindPromptItemId = (sessionId: string, journalItemId: string, promptKey: string): void =>
    this.sessions
      .get(sessionId)
      ?.prompts.bindJournalItemId(journalItemId, this.session(sessionId).threadId, promptKey)

  async dispatch(input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    fence: number
  }): Promise<AgentSessionDispatchOutcome> {
    return dispatchCodexTurn(this.session(input.sessionId), input, this.deps.requestTimeoutMs)
  }

  async cancelTurn(input: {
    sessionId: string
    turnId: string
    fence: number
  }): Promise<{ cancelled: boolean }> {
    const session = this.session(input.sessionId)
    try {
      await session.connection.request(
        'turn/interrupt',
        { threadId: session.threadId, turnId: input.turnId },
        { timeoutMs: this.deps.requestTimeoutMs }
      )
      return { cancelled: true }
    } catch (error) {
      // Codex declining names a turn it no longer owns; anything else leaves the
      // cancel unconfirmed and must surface as such.
      if (isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error)) {
        return { cancelled: false }
      }
      throw error
    }
  }

  async answerPrompt(input: {
    sessionId: string
    itemId: string
    kind: 'approval' | 'question'
    optionId: string
    fence: number
  }): Promise<void> {
    const session = this.session(input.sessionId)
    answerCodexPrompt(session.prompts, session.connection, input.itemId, input.optionId)
  }

  async setOption(
    input: StructuredAgentSessionSetOptionInput
  ): Promise<Readonly<Record<string, string>>> {
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

  /** Reaps one session's child. The proven handle chain is already durable, so
   *  a graceful close loses nothing. */
  async closeSession(sessionId: string): Promise<void> {
    const attempt = this.acquisitions.get(sessionId)
    if (attempt) {
      attempt.cancelled = true
      await attempt.window.connection?.close()
      await attempt.finished
    }
    await closeCodexPublishedSession(this.sessions, sessionId, this.deps.onEvent)
  }

  async closeAll(): Promise<void> {
    this.acquisitions.close()
    while (this.sessions.size > 0 || this.acquisitions.size > 0) {
      const sessionIds = new Set([...this.sessions.keys(), ...this.acquisitions.sessionIds()])
      await Promise.all([...sessionIds].map((sessionId) => this.closeSession(sessionId)))
    }
  }

  releaseAcquisition = (input: { sessionId: string }): Promise<void> =>
    this.closeSession(input.sessionId)

  private session(sessionId: string): CodexSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`no live codex app-server for session ${sessionId}`)
    }
    return session
  }
}
