import { dispatchClaudeCommand } from './claude-structured-command-dispatch'
import { isKillDeliveredExitReceipt } from './claude-kill-delivered-exit-receipt'
import { claudeAcquireFailure } from '../sdk-transport/claude-startup-failure'
import { claudeStartPublication, openClaudeStart } from './claude-structured-start-ending'
import { AgentSessionStartEndings } from '../../native-chat/agent-session-wire/startup/structured-agent-session-start-failure'
import type {
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter
} from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { stopCurrentClaudeBackgroundTasks } from './claude-structured-control-actions'
import { claudeHeldSends, claudeHoldsDispatch } from './turns/claude-command-lifecycle'
import {
  releaseClaudeAcquisition,
  type ClaudeReleaseRequest
} from './claude-structured-acquisition-release'
import { acquireClaudeSession } from './claude-structured-session-acquisition'
import { supportsClaudeStructuredLocation } from './launch/claude-structured-location-support'
import * as claudeOptions from './launch/claude-structured-options'
import { dispatchClaudeMessage } from './launch/claude-structured-message-options'
import { readClaudeStructuredSessionOptions } from './launch/claude-structured-session-options'
import { noteClaudeModelPick } from './claude-structured-execution-observations'
import {
  ClaudeAcquisitionRegistry,
  type ClaudeSession,
  type ClaudeSessionExit,
  type ClaudeStructuredSessionAdapterDeps,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-state'
import { closeAllClaudeSessions } from './claude-structured-session-close'
import { claudeStoppedRequestEndWait } from './turns/claude-request-end-wait'
import {
  finishClaudeCloseAfterExit,
  drainClaudeObservedExits,
  liveClaudeSession,
  observeClaudeSessionExit,
  settleClaudeUnexpectedExit,
  type ClaudeExitLifecycle
} from './claude-structured-session-exit-lifecycle'
import { drainClaudeChildWork } from '../child-work/claude-child-work-evidence'
import {
  deliverClaudeConnectionEvent,
  emitClaudeStructuredSessionEvent
} from './claude-structured-event-delivery'
import {
  answerClaudeStructuredPrompt,
  cancelClaudeStructuredTurn,
  dismissClaudeStructuredPrompt,
  settleClaudePromptFreeingChild
} from './journal/claude-structured-prompt-ownership'
import { claudePromptCancelRoute } from './journal/claude-structured-prompt-replies'
import { claudeForkForRewind } from '../transcripts/claude-rewind-fork'
import { copyClaudeConversation } from '../transcripts/claude-conversation-copy'
import { ClaudeConversationNaming } from '../conversation-naming/claude-conversation-naming'
import { captureClaudeConversationTitleOwner } from './claude-conversation-title-owner'

export class ClaudeStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, ClaudeSession>()
  captureConversationTitleOwner = captureClaudeConversationTitleOwner(this.sessions)
  private readonly acquisitions = new ClaudeAcquisitionRegistry()
  private readonly exits = new Map<string, ClaudeSessionExit>()
  private readonly settledExitErrors = new Map<string, Error>()
  private readonly endings = new AgentSessionStartEndings()
  private readonly exitLifecycle: ClaudeExitLifecycle
  private readonly naming: ClaudeConversationNaming | undefined

  constructor(private readonly deps: ClaudeStructuredSessionAdapterDeps) {
    const { namingInputs: snapshot, requestTimeoutMs: timeoutMs } = deps
    this.naming = snapshot && new ClaudeConversationNaming({ snapshot, timeoutMs })
    this.atRestCommands = deps.atRestCommands
    this.exitLifecycle = {
      sessions: this.sessions,
      exits: this.exits,
      settledExitErrors: this.settledExitErrors,
      endings: this.endings,
      deps,
      emit: (session, event) => this.emit(session, event)
    }
  }

  supportsLocation = supportsClaudeStructuredLocation

  acquire = (input: StructuredAgentSessionAcquireInput) => {
    this.settledExitErrors.delete(input.identity.sessionId)
    this.endings.retire(input.identity.sessionId)
    const record = this.deps.namingRecord?.(input.identity.sessionId)
    const naming = this.naming?.acquire(input, record)
    const start = claudeStartPublication(this.sessions, this.endings, input.identity.sessionId)
    return acquireClaudeSession({
      input,
      deps: this.deps,
      sessions: this.sessions,
      acquisitions: this.acquisitions,
      exits: this.exits,
      ...(naming ? { naming } : {}),
      callbacks: {
        publish: start.publish,
        deliver: (attempt, sessionId, event, payload) =>
          deliverClaudeConnectionEvent(
            this.sessions,
            this.exits,
            attempt,
            sessionId,
            event,
            payload
          ),
        emit: (session, _events, event) => this.emit(session, event),
        handleExit: (sessionId, attempt, error) =>
          observeClaudeSessionExit(this.exitLifecycle, sessionId, attempt, error),
        finishClose: (sessionId, attempt) =>
          finishClaudeCloseAfterExit({
            sessions: this.sessions,
            exits: this.exits,
            closeExit: (sessionId) => this.releaseProviderSession({ sessionId }),
            sessionId,
            connection: attempt.connection,
            deps: { ...this.deps, settledExitErrors: this.settledExitErrors },
            afterClose: (close) => this.afterClose(sessionId, close)
          }),
        settleExit: (sessionId, exit) =>
          settleClaudeUnexpectedExit(this.exitLifecycle, sessionId, exit)
      }
    }).catch((error: unknown) => {
      start.failed()
      naming?.failed()
      throw claudeAcquireFailure(error)
    })
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
  copyConversation = copyClaudeConversation
  stopProviderNaming = (): void => this.naming?.stop()
  nameProviderConversation: StructuredAgentSessionAdapter['nameProviderConversation'] = (input) =>
    this.naming?.accept(input)
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
  backgroundTaskStops = (sessionId: string) =>
    this.sessions.has(sessionId) ? { supportsTaskStop: true, supportsStopAll: true } : undefined
  readCommands: NonNullable<StructuredAgentSessionAdapter['readCommands']> = (sessionId) =>
    this.sessions.get(sessionId)?.commands.commands
  readonly atRestCommands: ClaudeStructuredSessionAdapterDeps['atRestCommands']
  holdsDispatch = (sessionId: string): boolean => claudeHoldsDispatch(this.sessions.get(sessionId))
  requiresModelTransitionRestart = claudeOptions.claudeModelTransitionRestart(this.sessions)
  liveTurnId = (sessionId: string): string | null | undefined =>
    this.sessions.get(sessionId)?.translator?.currentTurnId
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
    claudeOptions.setClaudeStructuredSessionOption(
      this.session(input.sessionId),
      input,
      this.deps.requestTimeoutMs
    )
  open: NonNullable<StructuredAgentSessionAdapter['open']> = (request) =>
    openClaudeStart({
      request,
      sessions: this.sessions,
      exits: this.exits,
      endings: this.endings,
      deps: this.deps,
      emit: (session, event) => this.emit(session, event)
    })
  noteOptionPick: NonNullable<StructuredAgentSessionAdapter['noteOptionPick']> = (input) => {
    const session = this.sessions.get(input.sessionId)
    if (session?.fence === input.fence && input.key === 'model' && input.value) {
      noteClaudeModelPick(session, input.value)
    }
  }
  readOptions = (input: { sessionId: string; fence: number }) =>
    readClaudeStructuredSessionOptions(this.session(input.sessionId))
  releaseAcquisition = (input: ClaudeReleaseRequest): Promise<boolean> => {
    this.endings.retire(input.sessionId)
    return this.afterClose(input.sessionId, () => this.releaseProviderSession(input))
  }
  acknowledgeSessionRelease = (sessionId: string): void => {
    this.settledExitErrors.delete(sessionId)
  }
  startupEnding = (sessionId: string, generation: string) => this.endings.get(sessionId, generation)
  retireStartup = (id: string, generation: string) => this.endings.retire(id, generation)
  hasOwnedAcquisition = (sessionId: string): boolean =>
    this.acquisitions.get(sessionId) !== undefined ||
    this.sessions.has(sessionId) ||
    this.exits.has(sessionId)

  /** A close clears the session's tasks outside `emit`; its ending still reaches the host. */
  private async afterClose(sessionId: string, close: () => Promise<boolean>): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    try {
      const closed = await close()
      const receipt = this.settledExitErrors.get(sessionId)
      if (closed && isKillDeliveredExitReceipt(receipt)) {
        throw receipt
      }
      return closed
    } finally {
      this.publishChildWork(sessionId, session)
    }
  }

  private releaseProviderSession = (request: ClaudeReleaseRequest): Promise<boolean> =>
    releaseClaudeAcquisition({
      ...request,
      sessions: this.sessions,
      acquisitions: this.acquisitions,
      exits: this.exits,
      settledExitErrors: this.settledExitErrors,
      onExitProven: (sessionId, exit) =>
        settleClaudeUnexpectedExit(this.exitLifecycle, sessionId, exit),
      ...this.deps
    })

  closeSession: NonNullable<StructuredAgentSessionAdapter['closeSession']> = (
    sessionId,
    _,
    options
  ) =>
    this.releaseAcquisition({ sessionId, closeOptions: options }).finally(() => {
      if (!isKillDeliveredExitReceipt(this.settledExitErrors.get(sessionId))) {
        this.settledExitErrors.delete(sessionId)
      }
    })

  closeAll = (): Promise<void> => {
    this.endings.clear()
    return closeAllClaudeSessions({
      sessions: this.sessions,
      acquisitions: this.acquisitions,
      exits: this.exits,
      closeSession: this.closeSession,
      closeExit: (sessionId) => this.releaseAcquisition({ sessionId })
    })
  }

  private session(sessionId: string): ClaudeSession {
    return liveClaudeSession(this.exitLifecycle, sessionId)
  }
}
