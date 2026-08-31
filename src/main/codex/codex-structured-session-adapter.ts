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
import {
  closeFailedCodexAcquisition,
  stopSupersededCodexAcquisition
} from './codex-structured-acquisition-lifecycle'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { openCodexAppServerConnection } from './codex-app-server-connection'
import { codexProcessIdentity, codexProviderHandleLink } from './codex-structured-owner-identity'
import { buildCodexStructuredChildEnvironment } from './codex-structured-child-environment'
import { answerCodexPrompt } from './codex-structured-prompt-replies'
import { openCodexThread } from './codex-structured-thread-open'
import { dispatchCodexTurn, isCodexTurnOptionKey } from './codex-structured-turn-start'
import { supportsCodexStructuredLocation } from './codex-structured-location-support'
import {
  closeAllCodexSessions,
  closeCodexPublishedSession,
  closeCodexSession,
  handleCodexSessionExit
} from './codex-structured-session-close'
import {
  applyCodexStructuredSessionOption,
  readLiveCodexSessionOptions,
  reportedCodexThreadOptions,
  restoredCodexSessionOptions
} from './codex-structured-session-options'
import {
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
import { CodexStructuredTurnCancellation } from './codex-structured-turn-cancellation'

export type {
  CodexStructuredLaunch,
  CodexStructuredSessionAdapterDeps,
  CodexStructuredSessionEvent
} from './codex-structured-session-state'

export class CodexStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, CodexSession>()
  private readonly acquisitions = new CodexAcquisitionRegistry()
  private readonly turnCancellation: CodexStructuredTurnCancellation

  constructor(private readonly deps: CodexStructuredSessionAdapterDeps) {
    this.turnCancellation = new CodexStructuredTurnCancellation({
      captureTurnProcesses: deps.captureTurnProcesses,
      terminateTurnProcesses: deps.terminateTurnProcesses,
      requestTimeoutMs: deps.requestTimeoutMs,
      emit: (session, event) => this.emit(session, event)
    })
  }

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
      await stopSupersededCodexAcquisition({
        sessionId,
        registry: this.acquisitions,
        replacement: attempt,
        previous: previousAttempt
      })
      this.acquisitions.assertCurrent(sessionId, attempt)
      if (!(await closeCodexPublishedSession(this.sessions, sessionId, this.deps.onEvent))) {
        throw new Error(`codex app-server for session ${sessionId} could not be stopped`)
      }
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
          cwd: launch.cwd,
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
          onExit: (error) => {
            acquisition.prompts.clear()
            handleCodexSessionExit({
              sessions: this.sessions,
              sessionId,
              connection: acquisition.connection,
              error,
              ...(this.deps.onEvent ? { onEvent: this.deps.onEvent } : {})
            })
          }
        }
      )
      acquisition.connection = connection
      this.acquisitions.assertCurrent(sessionId, attempt)
      const opened = await openCodexThread(connection, launch, this.deps.requestTimeoutMs)
      this.acquisitions.assertCurrent(sessionId, attempt)
      primaryThreadId = opened.threadId
      translator?.restoreThread(opened.threadId, opened.thread ?? {})
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
      const session: CodexSession = {
        connection,
        ended: false,
        threadId: opened.threadId,
        historyPath: opened.historyPath,
        prompts: acquisition.prompts,
        options: restoredCodexSessionOptions(input.options),
        reportedOptions: reportedCodexThreadOptions(opened),
        turnIdWaiters: [],
        translator
      }
      this.turnCancellation.register(session)
      this.sessions.set(sessionId, session)
      for (const event of acquisition.drain()) {
        event()
      }
      return acquired
    } catch (error) {
      // Reap this attempt's child only. A replacement already published for the
      // same session keeps running.
      if (this.sessions.get(sessionId)?.connection !== acquisition.connection) {
        return closeFailedCodexAcquisition({
          sessionId,
          registry: this.acquisitions,
          attempt,
          cause: error,
          dispose: () => translator?.dispose()
        })
      }
      this.acquisitions.deleteIfCurrent(sessionId, attempt)
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

  private handleNotification(sessionId: string, method: string, params: unknown): void {
    const session = this.sessions.get(sessionId)
    if (session && this.turnCancellation.handleNotification(sessionId, session, method, params)) {
      return
    }
    deliverCodexNotification(sessionId, session, method, params, (session, event) =>
      this.emit(session, event)
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
    const session = this.session(input.sessionId)
    await this.turnCancellation.captureBaseline(session)
    return dispatchCodexTurn(session, input, this.deps.requestTimeoutMs)
  }

  async cancelTurn(input: {
    sessionId: string
    turnId: string
    fence: number
  }): Promise<{ cancelled: boolean }> {
    const session = this.session(input.sessionId)
    return this.turnCancellation.cancel(session, input.turnId)
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

  closeSession = (sessionId: string): Promise<boolean> =>
    closeCodexSession(sessionId, this.sessions, this.acquisitions, this.deps.onEvent)
  disposeSession = (sessionId: string): Promise<boolean> => this.closeSession(sessionId)
  closeAll = (): Promise<void> =>
    closeAllCodexSessions(this.sessions, this.acquisitions, (sessionId) =>
      this.disposeSession(sessionId)
    )
  releaseAcquisition = (input: { sessionId: string }): Promise<boolean> =>
    this.closeSession(input.sessionId)

  private session(sessionId: string): CodexSession {
    const session = this.sessions.get(sessionId)
    if (!session || session.ended) {
      throw new Error(`no live codex app-server for session ${sessionId}`)
    }
    return session
  }
}
