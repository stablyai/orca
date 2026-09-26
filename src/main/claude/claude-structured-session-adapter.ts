import { compactClaudeSession, observeClaudeCompaction } from './claude-structured-compaction'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter,
  StructuredAgentSessionStartupFailure
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { stopClaudeBackgroundTasks } from './claude-structured-control-actions'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import { StructuredSessionCompaction } from '../native-chat/agent-session-wire/structured-session-compaction'
import { releaseClaudeAcquisition } from './claude-structured-acquisition-release'
import { acquireClaudeSession } from './claude-structured-session-acquisition'
import { supportsClaudeStructuredLocation } from './claude-structured-location-support'
import { setClaudeStructuredSessionOption } from './claude-structured-options'
import { readClaudeStructuredSessionOptions } from './claude-structured-session-options'
import {
  claudeStartupFailure,
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
import {
  drainClaudeObservedExits,
  observeClaudeSessionExit,
  settleClaudeUnexpectedExit,
  type ClaudeExitLifecycle
} from './claude-structured-session-exit-lifecycle'
import type { AgentSessionBackgroundTaskState } from '../../shared/agent-session-wire'
import { resolveClaudeProviderHistoryWindow } from './claude-structured-history-window'
import { drainClaudeChildWork } from './claude-child-work-evidence'
import {
  admitClaudePromptCancellation,
  answerClaudeStructuredPrompt,
  cancelClaudeStructuredTurn
} from './claude-structured-prompt-ownership'

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
  private readonly compactions = new StructuredSessionCompaction()
  private readonly sessions = new Map<string, ClaudeSession>()
  private readonly acquisitions = new ClaudeAcquisitionRegistry()
  private readonly exits = new Map<string, ClaudeSessionExit>()
  private readonly settledExitErrors = new Map<string, Error>()
  private readonly exitLifecycle: ClaudeExitLifecycle

  constructor(private readonly deps: ClaudeStructuredSessionAdapterDeps) {
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
  awaitStarted = async (
    sessionId: string
  ): Promise<void | StructuredAgentSessionStartupFailure> => {
    // An exit still closing is the host's child until it publishes, so its failed start answers.
    const session = this.sessions.get(sessionId) ?? this.exits.get(sessionId)?.session
    if (!session) {
      return
    }
    await session.startup.settled
    return claudeStartupFailure(session) ?? undefined
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
    if (event.type === 'ended') {
      session?.childWork.clear()
    } else if (event.type === 'message') {
      session?.childWork.observe(event.message)
    }
    const backgroundTasksChanged =
      event.type === 'ended'
        ? (session?.backgroundTasks.clear() ?? false)
        : event.type === 'message'
          ? (session?.backgroundTasks.observe(event.message, event.startsTurn === true) ?? false)
          : false
    if (event.type === 'message' && session?.commands.observe(event.message)) {
      session.events?.publish()
    }
    observeClaudeCompaction(this.compactions, event, session?.translator)
    this.deps.onEvent?.(event)
    if (backgroundTasksChanged) {
      this.deps.onBackgroundTasksChanged?.(
        event.sessionId,
        session ? backgroundTaskState(session) : null
      )
    }
    this.publishChildWork(event.sessionId, session, event.type === 'message' ? event.message : null)
  }

  /** After the journal handled the frame and the parent's own row was republished: the host
   *  never holds a child record ahead of the rows that frame wrote, and never before its parent. */
  private publishChildWork(
    sessionId: string,
    session: ClaudeSession | null | undefined,
    message: Record<string, unknown> | null = null
  ): void {
    const evidence = drainClaudeChildWork(session, message, this.deps.now?.() ?? Date.now())
    if (evidence.length > 0) {
      this.deps.onChildWorkEvidence?.(sessionId, evidence)
    }
  }

  bindPromptItemId(sessionId: string, journalItemId: string, promptKey: string): void {
    const session = this.sessions.get(sessionId)
    session?.prompts.bindJournalItemId(
      journalItemId,
      promptKey,
      session.translator?.currentTurnId ?? null
    )
  }

  dispatch: StructuredAgentSessionAdapter['dispatch'] = (input) =>
    dispatchClaudeTurn(this.session(input.sessionId), input, input.beforeDispatch)

  compact: NonNullable<StructuredAgentSessionAdapter['compact']> = (input) =>
    compactClaudeSession(this.session(input.sessionId), this.compactions, input)

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = (request) =>
    cancelClaudeStructuredTurn({
      request,
      sessions: this.sessions,
      compactions: this.compactions,
      admitPromptCancellation: (session, promptKey) =>
        admitClaudePromptCancellation(session, promptKey),
      onDispatchSettledLate: (settlement) =>
        this.deps.onDispatchSettledLate?.({ sessionId: request.sessionId, ...settlement }),
      ...(this.deps.requestTimeoutMs === undefined ? {} : { timeoutMs: this.deps.requestTimeoutMs })
    })
  stopBackgroundTasks: StructuredAgentSessionAdapter['stopBackgroundTasks'] = (input) => {
    const session = this.session(input.sessionId)
    const acquisitionGeneration = session.acquisitionGeneration
    return stopClaudeBackgroundTasks(
      session,
      this.deps.requestTimeoutMs,
      () =>
        Boolean(
          this.sessions.get(input.sessionId) === session &&
          session.fence === input.fence &&
          session.acquisitionGeneration === acquisitionGeneration &&
          session.backgroundTasks.state
        ),
      input.taskId
    )
  }
  backgroundTaskState: NonNullable<StructuredAgentSessionAdapter['backgroundTaskState']> = (
    sessionId
  ) => {
    const session = this.sessions.get(sessionId)
    return session ? backgroundTaskState(session) : undefined
  }
  readCommands: NonNullable<StructuredAgentSessionAdapter['readCommands']> = (sessionId) =>
    this.sessions.get(sessionId)?.commands.commands
  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (request) =>
    answerClaudeStructuredPrompt({ request, sessions: this.sessions })
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
  recordsContextUsage = (sessionId: string): boolean => this.sessions.has(sessionId)

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
      ...(this.deps.onBackgroundTasksChanged
        ? { onBackgroundTasksChanged: this.deps.onBackgroundTasksChanged }
        : {}),
      ...(this.deps.onEvent ? { onEvent: this.deps.onEvent } : {})
    })

  closeSession = (sessionId: string): Promise<boolean> =>
    // After the close, not before: releasing an exit still settling settles it on the way.
    this.closeSessionProcess(sessionId).finally(() => this.settledExitErrors.delete(sessionId))

  private closeSessionProcess(sessionId: string): Promise<boolean> {
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
      ...(this.deps.onBackgroundTasksChanged
        ? { onBackgroundTasksChanged: this.deps.onBackgroundTasksChanged }
        : {}),
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
