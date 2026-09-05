import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  answerClaudePrompt,
  cancelClaudeTurn,
  stopClaudeBackgroundTasks
} from './claude-structured-control-actions'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import { releaseClaudeAcquisition } from './claude-structured-acquisition-release'
import { acquireClaudeSession } from './claude-structured-session-acquisition'
export { CLAUDE_STRUCTURED_INIT_TIMEOUT_MS } from './claude-structured-session-acquisition'
import { supportsClaudeStructuredLocation } from './claude-structured-location-support'
import { setClaudeStructuredOption } from './claude-structured-options'
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
  settleClaudeExitedSession
} from './claude-structured-session-close'
import { readClaudeTranscriptLeafWithReproof } from './claude-transcript-branch-proof'

export type { ClaudeStructuredLaunch } from './claude-structured-launch-resolution'
export type {
  ClaudeAuthDiagnostic,
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

const DISPATCH_ACK_TIMEOUT_MS = 10_000

export class ClaudeStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, ClaudeSession>()
  private readonly acquisitions = new ClaudeAcquisitionRegistry()
  private readonly exits = new Map<string, ClaudeSessionExit>()

  constructor(private readonly deps: ClaudeStructuredSessionAdapterDeps) {}

  supportsLocation = supportsClaudeStructuredLocation

  acquire = (input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> =>
    acquireClaudeSession({
      input,
      deps: this.deps,
      sessions: this.sessions,
      acquisitions: this.acquisitions,
      exits: this.exits,
      callbacks: {
        deliver: (attempt, sessionId, event) => this.deliver(attempt, sessionId, event),
        emit: (session, events, event) => this.emit(session, events, event),
        handleExit: (sessionId, attempt, error) => this.handleExit(sessionId, attempt, error),
        settleExit: (sessionId, exit) => this.settleUnexpectedExit(sessionId, exit)
      }
    })

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
    // Re-enter the provider's close ladder before publishing lifecycle recovery.
    // An exit callback is root evidence only; the retained tree proof must run
    // before the host releases and reacquires this exact child.
    const closePromise = session.connection.close().catch(() => false)
    const exit: ClaudeSessionExit = {
      connection: session.connection,
      session,
      error,
      closePromise
    }
    this.exits.set(sessionId, exit)
    exit.publication = closePromise
      .then((proven) => (proven ? this.settleUnexpectedExit(sessionId, exit) : undefined))
      .catch(() => undefined)
  }

  /** Resolves once every first-hand exit observed so far has published its
   *  lifecycle event — or has failed its tree proof and stayed indexed for a
   *  retry. Publication trails observation by the close ladder and the
   *  transcript cursor write, so nothing outside can otherwise tell the two
   *  apart without guessing at wall-clock. */
  drainObservedExits = async (): Promise<void> => {
    const awaited = new Set<Promise<void>>()
    for (;;) {
      const pending = [...this.exits.values()]
        .map((exit) => exit.publication)
        .filter(
          (publication): publication is Promise<void> =>
            publication !== undefined && !awaited.has(publication)
        )
      if (pending.length === 0) {
        return
      }
      for (const publication of pending) {
        awaited.add(publication)
      }
      // A publication can settle an exit that itself observes another; only the
      // ones this pass has not already awaited keep the loop going.
      await Promise.all(pending)
    }
  }

  /** Lifecycle recovery is published only after the child tree proof is true. */
  private settleUnexpectedExit(sessionId: string, exit: ClaudeSessionExit): Promise<void> {
    exit.settlementPromise ??= (async () => {
      if (this.exits.get(sessionId) !== exit) {
        settleClaudeExitedSession(exit.session)
        return
      }
      // Persist the transcript-derived cursor before publishing the lifecycle
      // event that lets the host release and reacquire this exact child.
      await this.persistSessionHandle(sessionId, exit.session).catch(() => undefined)
      if (this.exits.get(sessionId) !== exit) {
        settleClaudeExitedSession(exit.session)
        return
      }
      this.exits.delete(sessionId)
      const ended: ClaudeStructuredSessionEvent = {
        type: 'ended',
        sessionId,
        reason: exit.error.message,
        cause: 'unexpected-exit',
        fence: exit.session.fence,
        acquisitionGeneration: exit.session.acquisitionGeneration
      }
      try {
        this.emit(exit.session, exit.session.events, ended)
      } finally {
        settleClaudeExitedSession(exit.session)
      }
    })()
    return exit.settlementPromise
  }

  private async persistSessionHandle(sessionId: string, session: ClaudeSession): Promise<void> {
    try {
      const transcriptLeaf = this.deps.readTranscriptLeaf
        ? await readClaudeTranscriptLeafWithReproof({
            readTranscriptLeaf: this.deps.readTranscriptLeaf,
            providerSessionId: session.providerSessionId,
            previousLeafUuid: session.leafUuid,
            claudeConfigDir: session.claudeConfigDir
          })
        : null
      if (transcriptLeaf) {
        session.leafUuid = transcriptLeaf
      }
    } catch {
      // A stale or unavailable tail must not overwrite the last observed leaf.
    }
    await this.deps.persistHandle?.({
      sessionId,
      providerSessionId: session.providerSessionId,
      leafUuid: session.leafUuid,
      fence: session.fence
    })
  }

  private emit(
    session: ClaudeSession | null,
    _events: StructuredAgentSessionEventSink | undefined,
    event: ClaudeStructuredSessionEvent
  ): void {
    const backgroundTasksChanged =
      event.type === 'ended'
        ? (session?.backgroundTasks.clear() ?? false)
        : event.type === 'message'
          ? (session?.backgroundTasks.observe(event.message, event.startsTurn === true) ?? false)
          : false
    session?.translator?.handle(event)
    this.deps.onEvent?.(event)
    if (backgroundTasksChanged) {
      this.deps.onBackgroundTasksChanged?.(event.sessionId, session?.backgroundTasks.state ?? null)
    }
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

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = (input) => {
    const session = this.session(input.sessionId)
    const acquisitionGeneration = session.acquisitionGeneration
    return cancelClaudeTurn(session, this.deps.requestTimeoutMs, () => {
      // Keep every ownership check adjacent to the provider interrupt. The
      // session map check fences a replaced child; the turn check fences a
      // delayed cancel after a newer turn was admitted on the same child.
      return (
        this.sessions.get(input.sessionId) === session &&
        session.fence === input.fence &&
        session.acquisitionGeneration === acquisitionGeneration &&
        (session.activeTurnId === undefined
          ? session.dispatchSequence === 0
          : session.activeTurnId === input.turnId &&
            session.activeTurnSequence === session.dispatchSequence)
      )
    })
  }
  stopBackgroundTasks: StructuredAgentSessionAdapter['stopBackgroundTasks'] = (input) => {
    const session = this.session(input.sessionId)
    const acquisitionGeneration = session.acquisitionGeneration
    return stopClaudeBackgroundTasks(session, this.deps.requestTimeoutMs, () =>
      Boolean(
        this.sessions.get(input.sessionId) === session &&
        session.fence === input.fence &&
        session.acquisitionGeneration === acquisitionGeneration &&
        session.backgroundTasks.state
      )
    )
  }
  backgroundTaskState: NonNullable<StructuredAgentSessionAdapter['backgroundTaskState']> = (
    sessionId
  ) => this.sessions.get(sessionId)?.backgroundTasks.state
  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (input) =>
    answerClaudePrompt(this.session(input.sessionId), input)
  setOption: StructuredAgentSessionAdapter['setOption'] = (input) =>
    setClaudeStructuredOption(this.session(input.sessionId), input, this.deps.requestTimeoutMs)
  readOptions = (input: { sessionId: string; fence: number }) =>
    readClaudeStructuredSessionOptions(this.session(input.sessionId), this.deps.requestTimeoutMs)

  readOptionRestoreFailures = (sessionId: string): readonly string[] => [
    ...(this.sessions.get(sessionId)?.restoreSkippedOptions ?? [])
  ]

  releaseAcquisition = (input: { sessionId: string }): Promise<boolean> =>
    releaseClaudeAcquisition({
      sessionId: input.sessionId,
      sessions: this.sessions,
      acquisitions: this.acquisitions,
      exits: this.exits,
      onExitProven: (sessionId, exit) => this.settleUnexpectedExit(sessionId, exit),
      ...(this.deps.persistHandle ? { persistHandle: this.deps.persistHandle } : {}),
      ...(this.deps.onBackgroundTasksChanged
        ? { onBackgroundTasksChanged: this.deps.onBackgroundTasksChanged }
        : {}),
      ...(this.deps.onEvent ? { onEvent: this.deps.onEvent } : {})
    })

  closeSession = (sessionId: string): Promise<boolean> => {
    if (this.exits.has(sessionId)) {
      return this.releaseAcquisition({ sessionId })
    }
    return closeClaudeSession({
      sessionId,
      sessions: this.sessions,
      acquisitions: this.acquisitions,
      ...(this.deps.persistHandle ? { persistHandle: this.deps.persistHandle } : {}),
      ...(this.deps.readTranscriptLeaf ? { readTranscriptLeaf: this.deps.readTranscriptLeaf } : {}),
      ...(this.deps.onBackgroundTasksChanged
        ? { onBackgroundTasksChanged: this.deps.onBackgroundTasksChanged }
        : {}),
      ...(this.deps.onEvent ? { onEvent: this.deps.onEvent } : {})
    })
  }

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
      throw new Error(`no live claude stream-json session for ${sessionId}`)
    }
    return session
  }
}
