import type { SubmissionRejectionFact } from '../../shared/agent-session-failure'
import { dispatchClaudeCommand } from './claude-structured-command-dispatch'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { stopClaudeBackgroundTasks } from './claude-structured-control-actions'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import { claudeHoldsDispatch } from './claude-command-lifecycle'
import { releaseClaudeAcquisition } from './claude-structured-acquisition-release'
import { acquireClaudeSession } from './claude-structured-session-acquisition'
import { supportsClaudeStructuredLocation } from './claude-structured-location-support'
import { setClaudeStructuredSessionOption } from './claude-structured-options'
import { readClaudeStructuredSessionOptions } from './claude-structured-session-options'
import {
  claudeStartupFailureFact,
  claudeStartupSettledWithin
} from './claude-structured-session-startup-state'
import { CLAUDE_DEFAULT_REQUEST_TIMEOUT_MS } from './claude-agent-sdk-control-requests'
import {
  ClaudeAcquisitionRegistry,
  type ClaudeAcquisitionAttempt,
  type ClaudeSession,
  type ClaudeSessionExit,
  type ClaudeStructuredSessionAdapterDeps,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-state'
import { closeAllClaudeSessions, closeClaudeSession } from './claude-structured-session-close'
import { claudeLiveWork, claudeStoppedRequestEndWait } from './claude-request-end-wait'
import {
  drainClaudeObservedExits,
  observeClaudeSessionExit,
  settleClaudeUnexpectedExit,
  type ClaudeExitLifecycle
} from './claude-structured-session-exit-lifecycle'
import type { AgentSessionBackgroundTaskState } from '../../shared/agent-session-wire'
import { resolveClaudeProviderHistoryWindow } from './claude-structured-history-window'
import { claudePromptCardWritten, drainClaudeChildWork } from './claude-child-work-evidence'
import {
  answerClaudeStructuredPrompt,
  cancelClaudeStructuredTurn,
  dismissClaudeStructuredPrompt
} from './claude-structured-prompt-ownership'
import { claudePromptCancelRoute } from './claude-structured-prompt-replies'

export type { ClaudeStructuredLaunch } from './claude-structured-launch-resolution'
export type {
  ClaudeAuthDiagnostic,
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

function backgroundTaskState(session: ClaudeSession): AgentSessionBackgroundTaskState | null {
  const state = session.backgroundTasks.state
  return state ? { ...state, supportsTaskStop: true } : null
}

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

  // Orca's marker-based rewind proof can never pass on the real binary; rewind returns via a fork.
  rewindSupport: NonNullable<StructuredAgentSessionAdapter['rewindSupport']> = () => ({
    supported: false,
    reason: 'unsupported'
  })

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

  /** Resolves once every first-hand exit observed so far has published its
   *  lifecycle event — or, with neither its tree proven gone nor its root's exit
   *  observed, stayed indexed for a retry. Publication trails observation by the close ladder and the
   *  transcript cursor write, so nothing outside can otherwise tell the two
   *  apart without guessing at wall-clock. */
  drainObservedExits = (): Promise<void> => drainClaudeObservedExits(this.exits)

  /** Resolves once a published session's startup has landed, faulted, or been ended by a close;
   *  with the reason when it did not land. */
  awaitStarted = async (sessionId: string): Promise<void | SubmissionRejectionFact> => {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }
    await session.startup.settled
    return claudeStartupFailureFact(session) ?? undefined
  }

  /** Restart reconciliation reads the transcript a resume replays; these maps track liveness. */
  providerHistoryWindow: NonNullable<StructuredAgentSessionAdapter['providerHistoryWindow']> = (
    input
  ) =>
    resolveClaudeProviderHistoryWindow({
      identity: input.identity,
      accountHomePath: input.accountHome.path,
      hasLiveSession:
        this.sessions.has(input.identity.sessionId) || this.exits.has(input.identity.sessionId)
    })

  private emit(session: ClaudeSession | null, event: ClaudeStructuredSessionEvent): void {
    // The host's child records, fed by the decoder's evidence drained below, are what every surface
    // and every Stop reads; the tracker's roster is kept only for tests that compare the two.
    if (event.type === 'ended') {
      session?.childWork.clear()
      session?.backgroundTasks.clear()
    } else if (event.type === 'message') {
      session?.childWork.observe(event.message)
      session?.backgroundTasks.observe(event.message, event.startsTurn === true)
    } else if (event.type === 'prompt-cancelled') {
      // A withdrawn request frees its child before its card closes: the journal may take that
      // write, and publish it, as it is submitted.
      this.publishChildWork(event.sessionId, session)
    }
    if (event.type === 'message' && session?.commands.observe(event.message)) {
      session.events?.publish()
    }
    session?.translator?.handle(event)
    this.deps.onEvent?.(event)
    this.publishChildWork(event.sessionId, session, event.type === 'message' ? event.message : null)
    // A subagent's card holds it waiting only once its row is written: its wait goes out after.
    void claudePromptCardWritten(session, event)?.then(() => this.publishChildWork(event.sessionId))
  }

  /** After the journal handled the frame, which republished the parent's own row: the host never
   *  holds a child record ahead of the rows that frame wrote, and never before its parent. */
  private publishChildWork(
    sessionId: string,
    session: ClaudeSession | null | undefined = this.sessions.get(sessionId),
    message: Record<string, unknown> | null = null
  ): void {
    const evidence = drainClaudeChildWork(session, message, this.deps.now?.() ?? Date.now())
    if (evidence.length > 0) {
      this.deps.onChildWorkEvidence?.(sessionId, evidence)
    }
  }

  bindPromptItemId(sessionId: string, journalItemId: string, promptKey: string): void {
    this.sessions.get(sessionId)?.prompts.bindJournalItemId(journalItemId, promptKey)
  }

  dispatch: StructuredAgentSessionAdapter['dispatch'] = (input) =>
    dispatchClaudeTurn(this.session(input.sessionId), input, input.beforeDispatch)

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
  // Stop is a session boundary for Claude: an interrupt can answer while background work keeps the
  // CLI running, and a refused one leaves the turn running.
  stopEndsSession = (): boolean => true
  awaitStoppedRequestEnd = claudeStoppedRequestEndWait(this.sessions)
  routePromptCancel = claudePromptCancelRoute
  dismissPrompt: NonNullable<StructuredAgentSessionAdapter['dismissPrompt']> = (request) =>
    this.freeingAsker(request, (freeing) =>
      dismissClaudeStructuredPrompt({ request: freeing, sessions: this.sessions })
    )
  /** An answered or dismissed request frees the child it blocked before the host records the card,
   *  so no row reads the child waiting beside a closed card; no provider frame says so first. */
  private freeingAsker = <R extends { sessionId: string; commit: () => Promise<void> }>(
    request: R,
    settle: (request: R) => Promise<void>
  ): Promise<void> => {
    const free = () => this.publishChildWork(request.sessionId)
    const commit = async (): Promise<void> => {
      free()
      await request.commit()
    }
    return settle({ ...request, commit }).finally(free)
  }
  stopBackgroundTasks: NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']> = async (
    input
  ) => {
    const session = this.session(input.sessionId)
    const acquisitionGeneration = session.acquisitionGeneration
    const isCurrent = () =>
      this.sessions.get(input.sessionId) === session &&
      session.fence === input.fence &&
      session.acquisitionGeneration === acquisitionGeneration
    try {
      return await stopClaudeBackgroundTasks(
        session,
        this.deps.requestTimeoutMs,
        isCurrent,
        input.taskIds
      )
    } finally {
      if (isCurrent()) {
        this.publishChildWork(input.sessionId, session)
      }
    }
  }
  /** The tracker's own roster, for the tests that compare it with the host's child records. No
   *  production code reads it: what runs, what a Stop reaches and what blocks a command are all
   *  read from the host's child records. */
  backgroundTaskState = (sessionId: string): AgentSessionBackgroundTaskState | null | undefined => {
    const session = this.sessions.get(sessionId)
    return session ? backgroundTaskState(session) : undefined
  }
  backgroundTaskStops: NonNullable<StructuredAgentSessionAdapter['backgroundTaskStops']> = (
    sessionId
  ) =>
    this.sessions.has(sessionId) ? { supportsTaskStop: true, supportsStopAll: true } : undefined
  readCommands: NonNullable<StructuredAgentSessionAdapter['readCommands']> = (sessionId) =>
    this.sessions.get(sessionId)?.commands.commands
  readonly atRestCommands: ClaudeStructuredSessionAdapterDeps['atRestCommands']
  holdsDispatch = (sessionId: string): boolean => {
    const session = this.sessions.get(sessionId)
    return session ? claudeHoldsDispatch(session) : false
  }
  liveWork: NonNullable<StructuredAgentSessionAdapter['liveWork']> = (sessionId) => {
    const session = this.sessions.get(sessionId)
    return session ? claudeLiveWork(session) : undefined
  }
  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (request) =>
    this.freeingAsker(request, (freeing) =>
      answerClaudeStructuredPrompt({ request: freeing, sessions: this.sessions })
    )
  setOption: StructuredAgentSessionAdapter['setOption'] = (input) =>
    setClaudeStructuredSessionOption(
      this.session(input.sessionId),
      input,
      this.deps.requestTimeoutMs
    )
  awaitOptionWritable = (sessionId: string): Promise<void> =>
    claudeStartupSettledWithin(
      this.sessions.get(sessionId),
      this.deps.requestTimeoutMs ?? CLAUDE_DEFAULT_REQUEST_TIMEOUT_MS
    )
  readOptions = (input: { sessionId: string; fence: number }) =>
    readClaudeStructuredSessionOptions(this.session(input.sessionId), this.deps.requestTimeoutMs)
  // Provider-level: a session at rest still reports the usage its journal recorded.
  recordsContextUsage = (): boolean => true

  readOptionRestoreFailures = (sessionId: string): readonly string[] => [
    ...(this.sessions.get(sessionId)?.restoreSkippedOptions ?? [])
  ]

  releaseAcquisition = (input: { sessionId: string }): Promise<boolean> =>
    this.afterClose(input.sessionId, () => this.releaseProviderSession(input.sessionId))

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
    // After the close, not before: releasing an exit still settling settles it on the way.
    this.closeSessionProcess(sessionId).finally(() => this.settledExitErrors.delete(sessionId))

  private closeSessionProcess(sessionId: string): Promise<boolean> {
    // An exit seen first settles as that exit, whoever asked for the close after it.
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
      ...(this.deps.onEvent ? { onEvent: this.deps.onEvent } : {})
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
