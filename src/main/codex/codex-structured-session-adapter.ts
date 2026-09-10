import * as codexRewind from './codex-structured-rewind'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import { StructuredSessionCompaction } from '../native-chat/agent-session-wire/structured-session-compaction'
import type {
  AgentSessionAcquisition,
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter,
  StructuredAgentSessionSetOptionInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { CodexJournalTranslationAdmission } from './codex-structured-journal-translation'
import { answerCodexPrompt } from './codex-structured-prompt-replies'
import { dispatchCodexTurn, isCodexTurnOptionKey } from './codex-structured-turn-start'
import { supportsCodexStructuredLocation } from './codex-structured-location-support'
import { CodexNamingOrphanRegistry } from './codex-naming-orphan-registry'
import { CodexStructuredSessionTeardown } from './codex-structured-session-teardown'
import {
  applyCodexStructuredSessionOption,
  readLiveCodexSessionOptions
} from './codex-structured-session-options'
import {
  CodexAcquisitionRegistry,
  requireLiveCodexSession,
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
import {
  captureCodexConversationName,
  startCodexConversationNamingForTurn
} from './codex-conversation-name-turn'
import { CodexStructuredTurnCancellation } from './codex-structured-turn-cancellation'
import { createCodexStructuredNotificationRetry } from './codex-structured-notification-retry'
import { acquireCodexStructuredSession } from './codex-structured-session-acquire'
import { compactCodexSession } from './codex-structured-compact-turn'

export type {
  CodexStructuredLaunch,
  CodexStructuredSessionAdapterDeps,
  CodexStructuredSessionEvent
} from './codex-structured-session-state'

export class CodexStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly compactions = new StructuredSessionCompaction()
  private readonly sessions = new Map<string, CodexSession>()
  private readonly acquisitions = new CodexAcquisitionRegistry()
  private readonly namingOrphans: CodexNamingOrphanRegistry
  private readonly turnCancellation: CodexStructuredTurnCancellation
  private readonly notificationRetries: ReturnType<typeof createCodexStructuredNotificationRetry>
  private readonly teardown: CodexStructuredSessionTeardown

  constructor(private readonly deps: CodexStructuredSessionAdapterDeps) {
    this.namingOrphans = new CodexNamingOrphanRegistry(deps.onNamingError)
    this.notificationRetries = createCodexStructuredNotificationRetry({
      sessionFor: (sessionId) => this.sessions.get(sessionId),
      translate: (sessionId, session, method, params) =>
        this.translateNotification(sessionId, session, method, params)
    })
    this.teardown = new CodexStructuredSessionTeardown({
      sessions: this.sessions,
      acquisitions: this.acquisitions,
      ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
      ...(deps.onBackgroundTasksChanged
        ? { onBackgroundTasksChanged: deps.onBackgroundTasksChanged }
        : {}),
      forgetNotificationRetries: (sessionId) => this.notificationRetries.clear(sessionId, null),
      namingOrphans: this.namingOrphans
    })
    this.turnCancellation = new CodexStructuredTurnCancellation({
      captureTurnProcesses: deps.captureTurnProcesses,
      terminateTurnProcesses: deps.terminateTurnProcesses,
      requestTimeoutMs: deps.requestTimeoutMs,
      emit: (session, event) => {
        const admission = this.emit(session, event)
        if (!admission.accepted && event.type === 'notification') {
          this.notificationRetries.handle(event.sessionId, event.method, event.params)
        }
        return admission
      }
    })
  }

  supportsLocation = (location: Parameters<typeof supportsCodexStructuredLocation>[0]): boolean =>
    supportsCodexStructuredLocation(location, this.deps.isWindowsProcessStartTimeAvailable)

  acquire = (input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> =>
    acquireCodexStructuredSession({
      input,
      deps: this.deps,
      sessions: this.sessions,
      acquisitions: this.acquisitions,
      namingOrphans: this.namingOrphans,
      turnCancellation: this.turnCancellation,
      notificationRetries: this.notificationRetries,
      deliver: (acquisition, sessionId, event, retainedBytes) =>
        this.deliver(acquisition, sessionId, event, retainedBytes),
      handleServerRequest: (sessionId, request) => this.handleServerRequest(sessionId, request),
      handleUnhandledFrame: (sessionId, kind, payload) =>
        this.handleUnhandledFrame(sessionId, kind, payload),
      forceCloseUnexpected: (sessionId, fence, acquisitionGeneration, reason) =>
        this.teardown.forceCloseUnexpected(sessionId, fence, acquisitionGeneration, reason)
    })

  /** Buffers pre-publication events and drops events from superseded children. */
  private deliver(
    acquisition: CodexAcquisitionAttempt['window'],
    sessionId: string,
    event: () => unknown,
    retainedBytes?: number
  ): void {
    if (acquisition.buffer(event, retainedBytes)) {
      return
    }
    if (this.sessions.get(sessionId)?.connection === acquisition.connection) {
      event()
    } else if (acquisition.isOverflowed) {
      // Pre-publication overflow is an acquisition failure, not a dropped
      // notification; tear down the child so callers retry explicitly.
      void acquisition.connection?.close()
    }
  }

  private translateNotification(
    sessionId: string,
    session: CodexSession,
    method: string,
    params: unknown
  ): CodexJournalTranslationAdmission {
    codexRewind.observeCodexRewindActivity(session, method, params)
    if (this.turnCancellation.handleNotification(sessionId, session, method, params)) {
      return { accepted: true }
    }
    captureCodexConversationName(sessionId, session, method, params, this.deps)
    return deliverCodexNotification(sessionId, session, method, params, (current, event) =>
      this.emit(current, event)
    )
  }

  /** Journal first so observers never see an event ahead of its durable row. */
  private emit(
    session: CodexSession,
    event: CodexStructuredSessionEvent
  ): CodexJournalTranslationAdmission {
    if (event.type === 'notification' && !session.backgroundTasks.canObserve(event)) {
      return { accepted: false, reason: 'failed' }
    }
    const admission = session.translator?.handle(event) ?? { accepted: true }
    if (!admission.accepted) {
      return admission
    }
    if (event.type === 'notification') {
      this.compactions.codex(event.sessionId, event.method, event.params)
      // After the admission check, so a refused frame is observed by the strip
      // only on the retry that also reaches the journal.
      if (session.backgroundTasks.observe(event)) {
        this.deps.onBackgroundTasksChanged?.(event.sessionId, session.backgroundTasks.state)
      }
    }
    if (event.type === 'ended') {
      this.compactions.ended(event.sessionId)
    }
    this.deps.onEvent?.(event)
    return admission
  }

  private handleServerRequest(
    sessionId: string,
    request: Parameters<typeof deliverCodexServerRequest>[2]
  ): void {
    const session = this.sessions.get(sessionId)
    deliverCodexServerRequest(sessionId, session, request, (current, event) =>
      this.emit(current, event)
    )
  }

  private handleUnhandledFrame(sessionId: string, kind: string, params: unknown): void {
    const session = this.sessions.get(sessionId)
    deliverCodexUnhandledFrame(sessionId, session, kind, params, (current, event) =>
      this.emit(current, event)
    )
  }

  backgroundTaskState: NonNullable<StructuredAgentSessionAdapter['backgroundTaskState']> = (
    sessionId
  ) => this.sessions.get(sessionId)?.backgroundTasks.state

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
    session.dispatchPending = true
    let outcome: AgentSessionDispatchOutcome
    try {
      await this.turnCancellation.captureBaseline(session)
      outcome = await dispatchCodexTurn(session, input, this.deps.requestTimeoutMs)
    } finally {
      // Rewind must be free again the moment the send settles; naming runs after.
      session.dispatchPending = false
    }
    if (outcome.state === 'accepted') {
      // The accepted user message is the first thing worth naming the thread
      // after, and the only text this session is sure Codex received.
      startCodexConversationNamingForTurn(input.sessionId, session, input.body, this.deps)
    }
    return outcome
  }

  async cancelTurn(input: {
    sessionId: string
    turnId: string
    fence: number
  }): Promise<{ cancelled: boolean }> {
    const session = this.session(input.sessionId)
    const turnId = this.compactions.providerTurnId(input.sessionId, input.turnId)
    return turnId ? this.turnCancellation.cancel(session, turnId) : { cancelled: false }
  }

  rewindSupport: NonNullable<StructuredAgentSessionAdapter['rewindSupport']> = (sessionId) =>
    this.sessions.get(sessionId)?.historyMode === 'legacy'
      ? { supported: false, reason: 'history-not-paginated' }
      : { supported: true }

  rewind: NonNullable<StructuredAgentSessionAdapter['rewind']> = (input) =>
    codexRewind.rewindCodexSession(this.session(input.sessionId), input, this.deps.requestTimeoutMs)

  recoverRewind: NonNullable<StructuredAgentSessionAdapter['recoverRewind']> = (input) =>
    codexRewind.recoverCodexRewind(this.session(input.sessionId), input, this.deps.requestTimeoutMs)

  compact: NonNullable<StructuredAgentSessionAdapter['compact']> = (input) =>
    compactCodexSession(
      this.session(input.sessionId),
      this.compactions,
      this.turnCancellation,
      input,
      this.deps.requestTimeoutMs
    )

  async answerPrompt(input: {
    sessionId: string
    itemId: string
    kind: 'approval' | 'question'
    optionId: string
    fence: number
  }): Promise<void> {
    const session = this.session(input.sessionId)
    answerCodexPrompt(session.prompts, session.connection, input.itemId, input.optionId)
    session.translator?.resolvePrompt(input.itemId)
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

  closeSession = (sessionId: string): Promise<boolean> => this.teardown.close(sessionId)
  forceCloseSession = (sessionId: string): Promise<boolean> => this.teardown.forceClose(sessionId)
  disposeSession = (sessionId: string): Promise<boolean> => this.teardown.close(sessionId)
  closeAll = (): Promise<void> => this.teardown.closeAll()
  releaseAcquisition = (input: { sessionId: string }): Promise<boolean> =>
    this.teardown.close(input.sessionId)

  private session(sessionId: string): CodexSession {
    return requireLiveCodexSession(this.sessions, sessionId)
  }
}
