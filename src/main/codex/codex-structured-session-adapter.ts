import { projectCodexSessionOptions } from './codex-structured-service-tier'
import * as codexRewind from './codex-structured-rewind'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { AgentSessionBackgroundTaskState } from '../../shared/agent-session-wire'
import { isCodexAppServerRequestError } from './app-server/codex-app-server-request-error'
import type {
  AgentSessionAcquisition,
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter,
  StructuredAgentSessionSetOptionInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionProviderOpenInput } from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
import type { CodexJournalTranslationAdmission } from './codex-structured-journal-translation'
import { dispatchCodexTurn, isCodexTurnOptionKey } from './codex-structured-turn-start'
import { agentSessionFailureFact, providerDiagnosticOf } from '../../shared/agent-session-failure'
import { supportsCodexStructuredLocation } from './codex-structured-location-support'
import { CodexStructuredSessionTeardown } from './codex-structured-session-teardown'
import {
  applyCodexStructuredSessionOption,
  prepareLiveCodexSessionOptions,
  readLiveCodexSessionOptions
} from './codex-structured-session-options'
import { resolvedCodexMessageOptions } from './codex-structured-message-options'
import {
  CodexAcquisitionRegistry,
  requireLiveCodexSession,
  type CodexAcquisitionAttempt,
  type CodexSession,
  type CodexStructuredSessionAdapterDeps,
  type CodexStructuredSessionEvent
} from './codex-structured-session-state'
import {
  deliverCodexServerRequest,
  deliverCodexUnhandledFrame,
  translateCodexNotification
} from './codex-structured-provider-events'
import * as turnEnd from './codex-structured-turn-end-settlement'
import { createCodexStructuredNotificationRetry } from './codex-structured-notification-retry'
import { acquireCodexStructuredSession } from './codex-structured-session-acquire'
import { codexStoppedRequestEndWait, settleCodexRequestEndWaiters } from './codex-request-end-wait'
import { changeCodexThreadGoal } from './codex-structured-thread-goal'
import { startCodexTerminalStopProbe } from './codex-background-terminals'
import { codexBackgroundTaskStops, stopCodexBackgroundTasks } from './codex-background-task-stops'
import {
  answerCodexStructuredPrompt,
  cancelCodexStructuredTurn
} from './codex-structured-prompt-ownership'

export type {
  CodexStructuredLaunch,
  CodexStructuredSessionAdapterDeps,
  CodexStructuredSessionEvent
} from './codex-structured-session-state'

export class CodexStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, CodexSession>()
  private readonly acquisitions = new CodexAcquisitionRegistry()
  private readonly notificationRetries: ReturnType<typeof createCodexStructuredNotificationRetry>
  private readonly teardown: CodexStructuredSessionTeardown

  constructor(private readonly deps: CodexStructuredSessionAdapterDeps) {
    this.atRestCommands = deps.atRestCommands
    this.notificationRetries = createCodexStructuredNotificationRetry({
      sessionFor: (sessionId) => this.sessions.get(sessionId),
      translate: (sessionId, session, method, params, observedAt, dispatchSequenceAtReceipt) =>
        translateCodexNotification({
          sessionId,
          session,
          method,
          params,
          observedAt,
          dispatchSequenceAtReceipt,
          emit: (current, event) => this.emit(current, event)
        })
    })
    this.teardown = new CodexStructuredSessionTeardown({
      sessions: this.sessions,
      acquisitions: this.acquisitions,
      ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
      ...(deps.logger ? { logger: deps.logger } : {}),
      forgetNotificationRetries: (sessionId) => this.notificationRetries.clear(sessionId, null)
    })
  }

  supportsLocation = supportsCodexStructuredLocation

  readCommands: NonNullable<StructuredAgentSessionAdapter['readCommands']> = (sessionId) =>
    this.sessions.get(sessionId)?.skillReport?.read()

  readonly atRestCommands: CodexStructuredSessionAdapterDeps['atRestCommands']

  acquire = (input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> =>
    acquireCodexStructuredSession({
      input,
      deps: this.deps,
      sessions: this.sessions,
      acquisitions: this.acquisitions,
      notificationRetries: this.notificationRetries,
      deliver: (acquisition, sessionId, event, retainedBytes) =>
        this.deliver(acquisition, sessionId, event, retainedBytes),
      handleServerRequest: (sessionId, request) => this.handleServerRequest(sessionId, request),
      handleUnhandledFrame: (sessionId, kind, payload) =>
        this.handleUnhandledFrame(sessionId, kind, payload),
      forceCloseUnexpected: (sessionId, fence, acquisitionGeneration, reason) =>
        this.teardown.forceCloseUnexpected(sessionId, fence, acquisitionGeneration, reason)
    })

  open = (input: StructuredAgentSessionProviderOpenInput) => {
    const attempt = this.acquisitions.get(input.sessionId)
    if (!attempt?.open) {
      return Promise.reject(new Error(`no spawned codex child for session ${input.sessionId}`))
    }
    return attempt.open(input)
  }

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
      // Overflow fails acquisition; close the child so callers can retry.
      void acquisition.connection?.close()
    }
  }

  /** Journal first so observers never see an event ahead of its durable row. */
  private emit(
    session: CodexSession,
    event: CodexStructuredSessionEvent
  ): CodexJournalTranslationAdmission {
    if (event.type === 'notification') {
      turnEnd.noteCodexTurnOpened(session, event.method, event.params)
      if (event.method === 'skills/changed') {
        session.skillReport?.refresh(true)
      }
    }
    const admission = session.translator?.handle(event) ?? { accepted: true }
    if (!admission.accepted) {
      return admission
    }
    if (event.type === 'notification') {
      // Only an admitted turn end settles; a refused one settles on the retry that lands.
      turnEnd.settleCodexSendsInEndedTurn(session, event, (settlement) =>
        this.deps.onDispatchSettledLate?.({ sessionId: event.sessionId, ...settlement })
      )
      // Child records observe refused frames only after a retry reaches the journal.
      session.backgroundTasks.observe(event, session.prompts.takeAbandonedCommands())
      // After the journal and the parent's republished row, never ahead of either.
      session.backgroundTasks.publishChildWork()
      startCodexTerminalStopProbe(this.sessions, event.sessionId, session, this.deps)
    }
    settleCodexRequestEndWaiters(session)
    this.deps.onEvent?.(event)
    return admission
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

  /** Test-only compatibility roster; host decisions use durable child records. */
  backgroundTaskState = (sessionId: string): AgentSessionBackgroundTaskState | null | undefined =>
    this.sessions.get(sessionId)?.backgroundTasks.state

  heldSends = (sessionId: string): ReadonlySet<string> | undefined =>
    this.sessions.get(sessionId)?.dispatchEchoes.heldSends()

  holdsLiveProviderProcess = (sessionId: string, acquisitionGeneration: string): boolean => {
    const session = this.sessions.get(sessionId)
    const starting = this.acquisitions.get(sessionId)
    if (starting?.acquisitionGeneration === acquisitionGeneration) {
      return !starting.exitProven && starting.window.connection?.pid !== undefined
    }
    return (
      session?.acquisitionGeneration === acquisitionGeneration &&
      session.connection.pid !== undefined &&
      !session.ended &&
      session.exitObservedAt === undefined
    )
  }

  backgroundTaskStops: NonNullable<StructuredAgentSessionAdapter['backgroundTaskStops']> = (
    sessionId
  ) => codexBackgroundTaskStops(this.sessions.get(sessionId))

  stopBackgroundTasks: NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']> = (
    input
  ) => stopCodexBackgroundTasks(this.sessions, input, this.deps.requestTimeoutMs)

  bindPromptItemId = (
    sessionId: string,
    journalItemId: string,
    promptKey: string,
    turnId?: string | null,
    threadId?: string
  ): void =>
    this.sessions
      .get(sessionId)
      ?.prompts.bindJournalItemId(
        journalItemId,
        threadId ?? this.session(sessionId).threadId,
        promptKey,
        turnId
      )

  async dispatch(
    input: Parameters<StructuredAgentSessionAdapter['dispatch']>[0]
  ): Promise<AgentSessionDispatchOutcome> {
    const session = this.session(input.sessionId)
    session.dispatchPending = true
    try {
      await input.beforeDispatch?.()
      input.signal?.throwIfAborted()
      input.onInputPreparation?.()
      const turnOptions = await waitForPromiseWithSignal(
        resolvedCodexMessageOptions(session, input.executionOptions),
        input.signal
      )
      input.signal?.throwIfAborted()
      return await dispatchCodexTurn(session, { ...input, turnOptions }, this.deps.requestTimeoutMs)
    } finally {
      session.dispatchPending = false
      settleCodexRequestEndWaiters(session)
    }
  }

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = (request) =>
    cancelCodexStructuredTurn({
      request,
      sessions: this.sessions,
      requestTimeoutMs: this.deps.requestTimeoutMs
    })

  awaitStoppedRequestEnd = codexStoppedRequestEndWait(this.sessions)

  rewindSupport: NonNullable<StructuredAgentSessionAdapter['rewindSupport']> = (sessionId) =>
    this.sessions.get(sessionId)?.historyMode === 'legacy'
      ? { supported: false, reason: 'history-not-paginated' }
      : { supported: true }

  rewind: NonNullable<StructuredAgentSessionAdapter['rewind']> = (input) =>
    codexRewind.rewindCodexSession(this.session(input.sessionId), input, this.deps.requestTimeoutMs)

  recoverRewind: NonNullable<StructuredAgentSessionAdapter['recoverRewind']> = (input) =>
    codexRewind.recoverCodexRewind(this.session(input.sessionId), input, this.deps.requestTimeoutMs)

  /** The reply acknowledges receipt; the translator observes turn completion separately. */
  compact: NonNullable<StructuredAgentSessionAdapter['compact']> = async (input) => {
    const session = this.session(input.sessionId)
    session.translator?.beginCommand(input.command)
    try {
      await session.connection.request(
        'thread/compact/start',
        { threadId: session.threadId },
        { timeoutMs: this.deps.requestTimeoutMs }
      )
      return { state: 'accepted', providerIdentity: null }
    } catch (error) {
      session.translator?.forgetCommand(input.command.turnId)
      if (isCodexAppServerRequestError(error)) {
        return {
          state: 'rejected',
          ...turnEnd.codexDispatchRejection(
            agentSessionFailureFact('providerRejected', { detail: providerDiagnosticOf(error) })
          )
        }
      }
      throw error
    }
  }

  changeThreadGoal: NonNullable<StructuredAgentSessionAdapter['changeThreadGoal']> = (input) =>
    changeCodexThreadGoal(
      this.session(input.sessionId),
      input.change,
      input.replacesGoal,
      this.deps.requestTimeoutMs,
      input.signal
    )

  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (request) =>
    answerCodexStructuredPrompt({ request, sessions: this.sessions })

  async setOption(
    input: StructuredAgentSessionSetOptionInput
  ): Promise<Readonly<Record<string, string>>> {
    // Legacy fastMode maps to a service tier before dispatch.
    if (!isCodexTurnOptionKey(input.key) && input.key !== 'fastMode') {
      throw new Error(`codex app-server has no thread option named ${input.key}`)
    }
    return applyCodexStructuredSessionOption(this.session(input.sessionId), input.key, input.value)
  }

  readOptions = (input: { sessionId: string; fence: number }) =>
    readLiveCodexSessionOptions(this.session(input.sessionId), this.deps.requestTimeoutMs)

  projectOptions = (sessionId: string, options: Readonly<Record<string, string>>) =>
    projectCodexSessionOptions(this.sessions.get(sessionId), options)

  prepareReadOptions = (input: { sessionId: string; fence: number }) =>
    prepareLiveCodexSessionOptions(this.session(input.sessionId), this.deps.requestTimeoutMs)

  closeSession: NonNullable<StructuredAgentSessionAdapter['closeSession']> = (sessionId) =>
    this.teardown.close(sessionId)
  forceCloseSession = (sessionId: string): Promise<boolean> => this.teardown.forceClose(sessionId)
  disposeSession: NonNullable<StructuredAgentSessionAdapter['disposeSession']> = (sessionId) =>
    this.teardown.close(sessionId)
  closeAll = (): Promise<void> => this.teardown.closeAll()
  releaseAcquisition = (input: { sessionId: string }): Promise<boolean> =>
    this.teardown.close(input.sessionId)
  hasOwnedAcquisition = (sessionId: string): boolean =>
    this.acquisitions.get(sessionId) !== undefined || this.sessions.has(sessionId)

  private session(sessionId: string): CodexSession {
    return requireLiveCodexSession(this.sessions, sessionId)
  }
}
