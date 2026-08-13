import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  openClaudeStreamJsonConnection,
  type ClaudeControlRequest,
  type ClaudeControlResponder
} from './claude-stream-json-connection'
import { answerClaudePrompt, cancelClaudeTurn } from './claude-structured-control-actions'
import { dispatchClaudeTurn, resolveClaudeReplayWaiter } from './claude-structured-dispatch'
import {
  handleClaudeInboundControl,
  handleClaudeInboundControlCancel
} from './claude-structured-inbound-control'
import {
  claudeAuthDiagnostic,
  readClaudeFrameString,
  readClaudeInit,
  readClaudeModels
} from './claude-structured-init-proof'
import {
  createClaudeInitDeadline,
  requestClaudeInitialization
} from './claude-structured-init-deadline'
import { supportsClaudeStructuredLocation } from './claude-structured-location-support'
import { CLAUDE_SPAWN_TOKEN_ENV, claudeProcessIdentity } from './claude-structured-owner-identity'
import {
  restoreClaudeStructuredSessionOptions,
  restoredClaudeStructuredSessionOptions,
  setClaudeStructuredOption
} from './claude-structured-options'
import { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import { readClaudeStructuredSessionOptions } from './claude-structured-session-options'
import { createClaudeSessionPublication } from './claude-structured-session-publication'
import { createClaudeSessionJournalTranslator } from './claude-structured-journal-translation'
import {
  cancelClaudeAcquisitionAttempt,
  ClaudeAcquisitionRegistry,
  type ClaudeAcquisitionAttempt,
  type ClaudeSession,
  type ClaudeStructuredSessionAdapterDeps,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-state'
import {
  closeClaudePublishedSession,
  settleClaudeExitedSession
} from './claude-structured-session-close'

export type { ClaudeStructuredLaunch } from './claude-structured-launch-resolution'
export type {
  ClaudeAuthDiagnostic,
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

export const CLAUDE_STRUCTURED_INIT_TIMEOUT_MS = 10_000
const DISPATCH_ACK_TIMEOUT_MS = 10_000

export class ClaudeStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, ClaudeSession>()
  private readonly acquisitions = new ClaudeAcquisitionRegistry()

  constructor(private readonly deps: ClaudeStructuredSessionAdapterDeps) {}

  supportsLocation = supportsClaudeStructuredLocation

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> {
    const sessionId = input.identity.sessionId
    const prompts = new ClaudePromptRegistry()
    const translator = createClaudeSessionJournalTranslator(input.events, prompts)
    const { previous, attempt } = this.acquisitions.start(sessionId, prompts)
    let liveSession: ClaudeSession | null = null
    let observedLeafUuid: string | null = null
    const initTimeoutMs = this.deps.initTimeoutMs ?? CLAUDE_STRUCTURED_INIT_TIMEOUT_MS
    const initDeadline = createClaudeInitDeadline(sessionId, initTimeoutMs)

    const onMessage = (message: Record<string, unknown>): void => {
      const init = readClaudeInit(message)
      if (init) {
        initDeadline.resolve(init)
      }
      observedLeafUuid = readClaudeFrameString(message, 'uuid') ?? observedLeafUuid
      if (liveSession) {
        liveSession.leafUuid = observedLeafUuid
        resolveClaudeReplayWaiter(liveSession, message)
      }
      this.deliver(attempt, sessionId, () =>
        this.emit(liveSession, input.events, { type: 'message', sessionId, message })
      )
    }
    const onControlRequest = (
      request: ClaudeControlRequest,
      responder?: ClaudeControlResponder
    ): void => {
      handleClaudeInboundControl({
        sessionId,
        attempt,
        request,
        responder,
        emit: (event) =>
          this.deliver(attempt, sessionId, () => this.emit(liveSession, input.events, event))
      })
    }

    try {
      await cancelClaudeAcquisitionAttempt(previous)
      this.acquisitions.assertCurrent(sessionId, attempt)
      await this.closePublishedSession(sessionId)
      this.acquisitions.assertCurrent(sessionId, attempt)
      const launch = await this.deps.resolveLaunch({ identity: input.identity })
      observedLeafUuid = launch.resumeLeafUuid
      this.acquisitions.assertCurrent(sessionId, attempt)
      const open = this.deps.openConnection ?? openClaudeStreamJsonConnection
      const connection = await open(
        {
          command: launch.command,
          args: launch.args,
          cwd: launch.cwd,
          env: {
            ...launch.env,
            [CLAUDE_SPAWN_TOKEN_ENV]: input.spawnToken,
            CLAUDE_CONFIG_DIR: launch.claudeConfigDir
          }
        },
        {
          onMessage,
          onControlRequest,
          onControlCancelRequest: ({ request_id: requestId }) => {
            handleClaudeInboundControlCancel({
              sessionId,
              attempt,
              requestId,
              emit: (event) =>
                this.deliver(attempt, sessionId, () => this.emit(liveSession, input.events, event))
            })
          },
          onExit: (error) => {
            if (!attempt.published) {
              initDeadline.reject(error)
            }
            this.handleExit(sessionId, attempt, error)
          }
        }
      )
      attempt.connection = connection
      this.acquisitions.assertCurrent(sessionId, attempt)
      initDeadline.start()
      const [initialization, init] = await Promise.all([
        requestClaudeInitialization(connection, sessionId, initTimeoutMs),
        initDeadline.promise
      ])
      const models = readClaudeModels(initialization)
      this.deliver(attempt, sessionId, () =>
        this.emit(liveSession, input.events, { type: 'options', sessionId, models })
      )
      initDeadline.clear()
      this.acquisitions.assertCurrent(sessionId, attempt)
      if (init.providerSessionId !== launch.providerSessionId) {
        throw new Error(
          `claude proved session ${init.providerSessionId}, expected ${launch.providerSessionId}`
        )
      }
      const settings = await connection
        .request('get_settings', {}, { timeoutMs: this.deps.requestTimeoutMs })
        .catch(() => null)
      this.deliver(attempt, sessionId, () =>
        this.emit(liveSession, input.events, {
          type: 'auth-diagnostic',
          sessionId,
          diagnostic: claudeAuthDiagnostic(init, settings)
        })
      )
      observedLeafUuid = init.uuid ?? observedLeafUuid
      const process = await claudeProcessIdentity(
        { ...input, pid: connection.pid },
        this.deps.readProcessStartTime
      )
      this.acquisitions.assertCurrent(sessionId, attempt)
      if (connection.closed) {
        throw new Error(`claude stream-json for session ${sessionId} exited while being acquired`)
      }
      const publication = createClaudeSessionPublication({
        connection,
        init,
        leafUuid: observedLeafUuid,
        fence: input.fence,
        resumed: launch.resumed,
        prompts,
        translator,
        events: input.events,
        process,
        options: restoredClaudeStructuredSessionOptions(input.options),
        ...(this.deps.mintLinkId ? { linkId: this.deps.mintLinkId() } : {}),
        observedAt: this.deps.now?.() ?? Date.now()
      })
      const acquired: AgentSessionAcquisition = publication.acquisition
      liveSession = publication.session
      await restoreClaudeStructuredSessionOptions(liveSession, this.deps.requestTimeoutMs)
      this.acquisitions.assertCurrent(sessionId, attempt)
      this.acquisitions.deleteIfCurrent(sessionId, attempt)
      this.sessions.set(sessionId, liveSession)
      attempt.published = true
      for (const event of attempt.buffered.splice(0)) {
        event()
      }
      return acquired
    } catch (error) {
      initDeadline.clear()
      this.acquisitions.deleteIfCurrent(sessionId, attempt)
      if (this.sessions.get(sessionId)?.connection !== attempt.connection) {
        translator?.dispose()
        prompts.clear()
        await attempt.connection?.close()
      }
      throw error
    } finally {
      attempt.finish()
    }
  }

  private deliver(attempt: ClaudeAcquisitionAttempt, sessionId: string, event: () => void): void {
    if (!attempt.published) {
      attempt.buffered.push(event)
      return
    }
    if (this.sessions.get(sessionId)?.connection === attempt.connection) {
      event()
    }
  }

  private handleExit(sessionId: string, attempt: ClaudeAcquisitionAttempt, error: Error): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.connection !== attempt.connection) {
      return
    }
    this.sessions.delete(sessionId)
    this.emit(session, session.events, { type: 'ended', sessionId, reason: error.message })
    settleClaudeExitedSession(session)
  }

  private emit(
    _session: ClaudeSession | null,
    _events: StructuredAgentSessionEventSink | undefined,
    event: ClaudeStructuredSessionEvent
  ): void {
    _session?.translator?.handle(event)
    this.deps.onEvent?.(event)
  }

  bindPromptItemId(
    sessionId: string,
    journalItemId: string,
    promptKey: string,
    questionId?: string
  ): void {
    this.sessions.get(sessionId)?.prompts.bindJournalItemId(journalItemId, promptKey, questionId)
  }

  dispatch: StructuredAgentSessionAdapter['dispatch'] = (input) =>
    dispatchClaudeTurn(
      this.session(input.sessionId),
      input,
      this.deps.dispatchAckTimeoutMs ?? DISPATCH_ACK_TIMEOUT_MS
    )

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = (input) =>
    cancelClaudeTurn(this.session(input.sessionId), this.deps.requestTimeoutMs)

  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (input) =>
    answerClaudePrompt(this.session(input.sessionId), input)

  setOption: StructuredAgentSessionAdapter['setOption'] = (input) =>
    setClaudeStructuredOption(this.session(input.sessionId), input, this.deps.requestTimeoutMs)

  readOptions = (input: { sessionId: string; fence: number }) =>
    readClaudeStructuredSessionOptions(this.session(input.sessionId), this.deps.requestTimeoutMs)

  releaseAcquisition(input: { sessionId: string }): Promise<void> {
    return this.closeSession(input.sessionId)
  }

  async closeSession(sessionId: string): Promise<void> {
    const attempt = this.acquisitions.get(sessionId)
    if (attempt) {
      attempt.cancelled = true
      await attempt.connection?.close()
      await attempt.finished
    }
    await this.closePublishedSession(sessionId)
  }

  private async closePublishedSession(sessionId: string): Promise<void> {
    await closeClaudePublishedSession({
      sessions: this.sessions,
      sessionId,
      ...(this.deps.persistHandle ? { persistHandle: this.deps.persistHandle } : {}),
      ...(this.deps.onEvent ? { onEvent: this.deps.onEvent } : {})
    })
  }

  async closeAll(): Promise<void> {
    this.acquisitions.close()
    while (this.sessions.size > 0 || this.acquisitions.size > 0) {
      const ids = new Set([...this.sessions.keys(), ...this.acquisitions.sessionIds()])
      await Promise.all([...ids].map((sessionId) => this.closeSession(sessionId)))
    }
  }

  private session(sessionId: string): ClaudeSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`no live claude stream-json session for ${sessionId}`)
    }
    return session
  }
}
