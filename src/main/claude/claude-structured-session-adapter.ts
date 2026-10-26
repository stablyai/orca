import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { dispatchClaudeCommand } from './claude-structured-command-dispatch'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { stopCurrentClaudeBackgroundTasks } from './claude-structured-control-actions'
import { claudeHeldSends, claudeHoldsDispatch } from './claude-command-lifecycle'
import { releaseClaudeAcquisition } from './claude-structured-acquisition-release'
import { acquireClaudeSession } from './claude-structured-session-acquisition'
import { supportsClaudeStructuredLocation } from './claude-structured-location-support'
import { setClaudeStructuredSessionOption } from './claude-structured-options'
import { dispatchClaudeMessage } from './claude-structured-message-options'
import { readClaudeStructuredSessionOptions } from './claude-structured-session-options'
import {
  ClaudeAcquisitionRegistry,
  type ClaudeAcquisitionAttempt,
  type ClaudeSession,
  type ClaudeSessionExit,
  type ClaudeStructuredSessionAdapterDeps,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-state'
import {
  closeAllClaudeSessions,
  closeClaudeSession,
  finishClaudeCloseAfterExit
} from './claude-structured-session-close'
import { claudeStoppedRequestEndWait } from './claude-request-end-wait'
import {
  drainClaudeObservedExits,
  observeClaudeSessionExit,
  settleClaudeUnexpectedExit,
  type ClaudeExitLifecycle
} from './claude-structured-session-exit-lifecycle'
import type { AgentSessionBackgroundTaskState } from '../../shared/agent-session-wire'
import { drainClaudeChildWork } from './claude-child-work-evidence'
import { emitClaudeStructuredSessionEvent } from './claude-structured-event-delivery'
import {
  answerClaudeStructuredPrompt,
  cancelClaudeStructuredTurn,
  dismissClaudeStructuredPrompt,
  settleClaudePromptFreeingChild
} from './claude-structured-prompt-ownership'
import { claudePromptCancelRoute } from './claude-structured-prompt-replies'
import { claudeForkForRewind } from './claude-rewind-fork'
import { openClaudeStructuredSession } from './claude-structured-session-open'

export type { ClaudeStructuredLaunch } from './claude-structured-launch-resolution'
export type {
  ClaudeAuthDiagnostic,
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

export class ClaudeStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, ClaudeSession>()
  private readonly acquisitions = new ClaudeAcquisitionRegistry()
  private readonly exits = new Map<string, ClaudeSessionExit>()
  private readonly settledExitErrors = new Map<string, Error>()
  private readonly exitLifecycle: ClaudeExitLifecycle

  constructor(private readonly deps: ClaudeStructuredSessionAdapterDeps) {
    this.atRestCommands = deps.atRestCommands
    this.exitLifecycle = {
      sessions: this.sessions,
      exits: this.exits,
      settledExitErrors: this.settledExitErrors,
      deps,
      emit: (session, event) => this.emit(session, event)
    }
  }

  supportsLocation = supportsClaudeStructuredLocation

  acquire = (input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> => {
    this.settledExitErrors.delete(input.identity.sessionId)
    return acquireClaudeSession({
      input,
      deps: this.deps,
      sessions: this.sessions,
      acquisitions: this.acquisitions,
      exits: this.exits,
      callbacks: {
        deliver: (attempt, sessionId, event) => this.deliver(attempt, sessionId, event),
        emit: (session, _events, event) => this.emit(session, event),
        handleExit: (sessionId, attempt, error) =>
          observeClaudeSessionExit(this.exitLifecycle, sessionId, attempt, error),
        finishClose: (sessionId, attempt) =>
          finishClaudeCloseAfterExit({
            sessions: this.sessions,
            sessionId,
            connection: attempt.connection,
            deps: this.deps,
            afterClose: (close) => this.afterClose(sessionId, close)
          }),
        settleExit: (sessionId, exit) =>
          settleClaudeUnexpectedExit(this.exitLifecycle, sessionId, exit)
      }
    })
  }

  private deliver(attempt: ClaudeAcquisitionAttempt, sessionId: string, event: () => void): void {
    if (!attempt.published) {
      attempt.buffered.push(event)
      return
    }
    if (
      this.sessions.get(sessionId)?.connection === attempt.connection ||
      this.exits.get(sessionId)?.connection === attempt.connection
    ) {
      event()
    }
  }

  /** Await exit publication after cleanup/cursor writes; unproven exits stay indexed for retry. */
  drainObservedExits = (): Promise<void> => drainClaudeObservedExits(this.exits)

  private emit(session: ClaudeSession | null, event: ClaudeStructuredSessionEvent): void {
    emitClaudeStructuredSessionEvent({
      session,
      event,
      deps: this.deps,
      publishChildWork: (id, child, message) => this.publishChildWork(id, child, message)
    })
  }

  /** Publish child records after the frame's journal rows and parent record. */
  private publishChildWork(
    sessionId: string,
    session: ClaudeSession | null | undefined = this.sessions.get(sessionId),
    message: Record<string, unknown> | null = null
  ): void {
    const evidence = drainClaudeChildWork(session, message, this.deps.now?.() ?? Date.now())
    if (evidence.length > 0) {
      this.deps.onChildWorkEvidence?.(sessionId, evidence, session?.events)
    }
  }

  bindPromptItemId(sessionId: string, journalItemId: string, promptKey: string): void {
    this.sessions.get(sessionId)?.prompts.bindJournalItemId(journalItemId, promptKey)
  }

  dispatch: StructuredAgentSessionAdapter['dispatch'] = (input) => {
    const { requestTimeoutMs, logger } = this.deps
    return dispatchClaudeMessage(this.session(input.sessionId), input, requestTimeoutMs, logger)
  }

  forkForRewind = claudeForkForRewind
  compact: NonNullable<StructuredAgentSessionAdapter['compact']> = (input) =>
    dispatchClaudeCommand(this.session(input.sessionId), input.command)

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = (request) =>
    cancelClaudeStructuredTurn({
      request,
      sessions: this.sessions,
      onDispatchSettledLate: (settlement) =>
        this.deps.onDispatchSettledLate?.({ sessionId: request.sessionId, ...settlement }),
      ...(this.deps.requestTimeoutMs === undefined ? {} : { timeoutMs: this.deps.requestTimeoutMs })
    })
  awaitStoppedRequestEnd = claudeStoppedRequestEndWait(this.sessions)
  routePromptCancel = claudePromptCancelRoute
  dismissPrompt: NonNullable<StructuredAgentSessionAdapter['dismissPrompt']> = (request) =>
    settleClaudePromptFreeingChild(this.asker(request), dismissClaudeStructuredPrompt)
  private asker = <R extends { sessionId: string }>(request: R) => ({
    request,
    sessions: this.sessions,
    free: () => this.publishChildWork(request.sessionId)
  })
  stopBackgroundTasks: NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']> = async (
    input
  ) =>
    stopCurrentClaudeBackgroundTasks({
      ...input,
      sessions: this.sessions,
      session: this.session(input.sessionId),
      timeoutMs: this.deps.requestTimeoutMs
    })
  /** Test-only roster; production ownership and Stop routing use host child records. */
  backgroundTaskState = (sessionId: string): AgentSessionBackgroundTaskState | null | undefined => {
    const session = this.sessions.get(sessionId)
    const state = session?.backgroundTasks.state
    return session && (state ? { ...state, supportsTaskStop: true } : null)
  }
  backgroundTaskStops: NonNullable<StructuredAgentSessionAdapter['backgroundTaskStops']> = (
    sessionId
  ) =>
    this.sessions.has(sessionId) ? { supportsTaskStop: true, supportsStopAll: true } : undefined
  readCommands: NonNullable<StructuredAgentSessionAdapter['readCommands']> = (sessionId) =>
    this.sessions.get(sessionId)?.commands.commands
  readonly atRestCommands: ClaudeStructuredSessionAdapterDeps['atRestCommands']
  holdsDispatch = (sessionId: string): boolean => claudeHoldsDispatch(this.sessions.get(sessionId))
  heldSends = (sessionId: string): ReadonlySet<string> | undefined => {
    const session = this.sessions.get(sessionId) ?? this.exits.get(sessionId)?.session
    const held = session && claudeHeldSends(session)
    return held ?? (this.settledExitErrors.has(sessionId) ? new Set() : undefined)
  }
  holdsLiveProviderProcess = (sessionId: string, acquisitionGeneration: string): boolean => {
    const session = this.sessions.get(sessionId)
    return (
      session?.acquisitionGeneration === acquisitionGeneration &&
      session.connection.pid !== undefined &&
      session.connection.exitVerdict.root === 'live'
    )
  }
  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (request) =>
    settleClaudePromptFreeingChild(this.asker(request), answerClaudeStructuredPrompt)
  setOption: StructuredAgentSessionAdapter['setOption'] = (input) =>
    setClaudeStructuredSessionOption(
      this.session(input.sessionId),
      input,
      this.deps.requestTimeoutMs
    )
  open: NonNullable<StructuredAgentSessionAdapter['open']> = async (request) => {
    try {
      return await openClaudeStructuredSession({
        request,
        session: this.session(request.sessionId),
        sessions: this.sessions,
        deps: this.deps,
        emit: (session, event) => this.emit(session, event)
      })
    } catch (error) {
      const exit = this.exits.get(request.sessionId)
      // Publish an already-observed exit before the host treats this rejection as its own fault.
      if (
        exit?.session.acquisitionGeneration === request.acquisitionGeneration &&
        exit.publication
      ) {
        await waitForPromiseWithSignal(exit.publication, request.signal)
      }
      throw error
    }
  }
  readOptions = (input: { sessionId: string; fence: number }) =>
    readClaudeStructuredSessionOptions(this.session(input.sessionId), this.deps.requestTimeoutMs)
  readOptionRestoreFailures = (sessionId: string): readonly string[] => {
    const session = this.sessions.get(sessionId)
    return session?.retiredModel !== undefined && !session.options.has('model') ? ['model'] : []
  }

  releaseAcquisition = (input: { sessionId: string }): Promise<boolean> =>
    this.afterClose(input.sessionId, () => this.releaseProviderSession(input.sessionId))
  acknowledgeSessionRelease = (sessionId: string): void => {
    this.settledExitErrors.delete(sessionId)
  }
  hasOwnedAcquisition = (sessionId: string): boolean =>
    this.acquisitions.get(sessionId) !== undefined ||
    this.sessions.has(sessionId) ||
    this.exits.has(sessionId)

  /** A close clears the session's tasks outside `emit`; its ending still reaches the host. */
  private async afterClose(sessionId: string, close: () => Promise<boolean>): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    try {
      return await close()
    } finally {
      this.publishChildWork(sessionId, session)
    }
  }

  private releaseProviderSession = (sessionId: string): Promise<boolean> =>
    releaseClaudeAcquisition({
      sessionId,
      sessions: this.sessions,
      acquisitions: this.acquisitions,
      exits: this.exits,
      onExitProven: (sessionId, exit) =>
        settleClaudeUnexpectedExit(this.exitLifecycle, sessionId, exit),
      ...(this.deps.persistHandle ? { persistHandle: this.deps.persistHandle } : {}),
      ...(this.deps.onEvent ? { onEvent: this.deps.onEvent } : {})
    })

  closeSession = (sessionId: string): Promise<boolean> =>
    // Clear diagnostics after close, which may still settle an observed exit.
    this.closeSessionProcess(sessionId).finally(() => this.settledExitErrors.delete(sessionId))

  private closeSessionProcess(sessionId: string): Promise<boolean> {
    // Preserve an exit observed before the requested close.
    if (this.exits.has(sessionId)) {
      return this.releaseAcquisition({ sessionId })
    }
    return this.afterClose(sessionId, () => this.closeProviderSession(sessionId))
  }

  private closeProviderSession = (sessionId: string): Promise<boolean> =>
    closeClaudeSession({
      sessionId,
      sessions: this.sessions,
      acquisitions: this.acquisitions,
      ...(this.deps.persistHandle ? { persistHandle: this.deps.persistHandle } : {}),
      ...(this.deps.onEvent ? { onEvent: this.deps.onEvent } : {}),
      ...(this.deps.logger ? { logger: this.deps.logger } : {})
    })

  closeAll = (): Promise<void> =>
    closeAllClaudeSessions({
      sessions: this.sessions,
      acquisitions: this.acquisitions,
      exits: this.exits,
      closeSession: this.closeSession,
      closeExit: (sessionId) => this.releaseAcquisition({ sessionId })
    })

  private session(sessionId: string): ClaudeSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      // A child that just exited is named by its own diagnostic, not by its absence.
      throw (
        this.exits.get(sessionId)?.error ??
        this.settledExitErrors.get(sessionId) ??
        new Error(`no live claude stream-json session for ${sessionId}`)
      )
    }
    return session
  }
}
