import { randomUUID } from 'node:crypto'
import { withProviderDiagnostic } from '../../shared/agent-session-failure'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRefusal,
  AgentSessionPreSpawnError,
  isAgentSessionPreSpawnError,
  type AgentSessionAcquisition,
  type AgentSessionDispatchOutcome,
  type StructuredAgentSessionAcquireInput,
  type StructuredAgentSessionAdapter,
  type StructuredAgentSessionSetOptionInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { withObservedProviderExit } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import { acpAgentName } from './acp-structured-agent-definitions'
import { acquireAcpStructuredSession } from './acp-structured-acquire'
import { rejectedAcpDispatch, type AcpStructuredSession } from './acp-structured-session'
import type { ProviderStartAttempt } from '../provider-process/provider-acquisition-starts'
import { waitForAcpExit, type AcpStructuredConnection } from './acp-structured-connection'
import { AcpConnectionClosedError } from './acp-errors'
import { applyAcpMessageOptions } from './acp-message-execution-options'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { awaitAcpTurnEnd, interruptAcpTurn } from './acp-structured-stop'
import { acpDispatchPrompt } from './acp-prompt-content'
import {
  ACP_OPTION_WRITE_TIMEOUT_MS,
  ACP_STOP_GRACE_MS,
  type AcpStructuredSessionAdapterDeps
} from './acp-structured-session-adapter-deps'
import { readAcpLiveOptions } from './acp-structured-options'
import { writeAcpSessionOption } from './acp-session-option-write'
import { stopAcpChildren, acpChildStopCapabilities } from './acp-structured-child-stop'
import { acpStartupFailure, isAcpReadySession } from './acp-structured-child'
import { AcpStructuredChildren } from './acp-structured-child-lifecycle'
import { AcpConversationCopies } from './acp-conversation-copies'
import { supportsAcpStructuredLocation } from './acp-structured-location-support'

export class AcpStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  readonly atRestCommands: AcpStructuredSessionAdapterDeps['atRestCommands']
  private readonly children: AcpStructuredChildren
  private readonly copies: AcpConversationCopies
  constructor(private readonly deps: AcpStructuredSessionAdapterDeps) {
    this.atRestCommands = deps.atRestCommands
    this.children = new AcpStructuredChildren(deps)
    this.copies = new AcpConversationCopies(deps)
  }

  copyConversation: NonNullable<StructuredAgentSessionAdapter['copyConversation']> = (input) =>
    this.copies.copy(input)

  supportsLocation = (location: AgentSessionExecutionLocation): boolean => {
    const { spec, isWindowsProcessStartTimeAvailable } = this.deps
    return supportsAcpStructuredLocation(spec, location, isWindowsProcessStartTimeAvailable)
  }

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> {
    const sessionId = input.identity.sessionId
    const gate = this.deps.spec.launchGate?.enter(input.signal)
    const attempt = this.children.starts.begin(gate?.signal ?? input.signal)
    try {
      if (!(await this.children.stop(sessionId))) {
        throw new AgentSessionAcquisitionExitUnprovenError(
          new Error(
            `the previous ${this.deps.spec.agent} child for ${sessionId} could not be stopped`
          )
        )
      }
      return await this.start({ ...input, signal: attempt.signal }, attempt)
    } finally {
      this.children.starts.end(attempt)
      gate?.leave()
    }
  }

  private async start(
    input: StructuredAgentSessionAcquireInput,
    attempt: ProviderStartAttempt<AcpStructuredConnection>
  ): Promise<AgentSessionAcquisition> {
    const sessionId = input.identity.sessionId
    const generation = this.deps.mintGeneration?.() ?? randomUUID()
    try {
      const { acquisition, session } = await acquireAcpStructuredSession({
        acquire: input,
        deps: this.deps,
        generation,
        abandoned: () => attempt.signal.aborted,
        track: (connection) => {
          this.children.starts.track(attempt, connection)
          this.deps.spec.launchGate?.retain(connection)
        },
        onExit: (session) => {
          if (session && this.children.sessions.get(sessionId) === session) {
            this.children.finish(session, this.now())
          }
        },
        onConnectionLost: (session, error) => this.children.connectionLost(session, error),
        onSettled: (settlement) => this.deps.onDispatchSettledLate?.({ sessionId, ...settlement }),
        forceClose: (id) => void this.forceCloseSession(id)
      })
      if (attempt.signal.aborted) {
        session.dispose()
        throw new Error('closed while starting')
      }
      this.children.sessions.set(sessionId, session)
      return acquisition
    } catch (error) {
      const { connection } = attempt
      if (connection && error instanceof AcpConnectionClosedError) {
        // Wait briefly for process exit so startup failures include final diagnostics.
        await waitForAcpExit(connection, this.stopGraceMs(), attempt.signal)
      }
      // Capture spontaneous exit before close can classify it as requested.
      const exitedOnItsOwn = connection?.exited === true && !attempt.signal.aborted
      if (connection && !(await connection.close().catch(() => false))) {
        // Retain failed cleanup for retry before another child can spawn.
        this.children.starts.retainFailed(sessionId, connection)
        throw new AgentSessionAcquisitionExitUnprovenError(error)
      }
      if (attempt.signal.aborted) {
        const closed = new Error(
          `${acpAgentName(this.deps.spec.agent)} was closed while starting`,
          { cause: error }
        )
        throw connection ? closed : new AgentSessionPreSpawnError(closed)
      }
      if (connection && exitedOnItsOwn && !isAgentSessionPreSpawnError(error)) {
        throw new AgentSessionAcquisitionExitProvenError(
          withObservedProviderExit(
            new Error(connection.stderrTail() || String(error), { cause: error })
          )
        )
      }
      throw error
    }
  }

  open: NonNullable<StructuredAgentSessionAdapter['open']> = async (input) => {
    const child = this.children.sessions.get(input.sessionId)
    if (
      !child ||
      child.fence !== input.fence ||
      child.acquisitionGeneration !== input.acquisitionGeneration ||
      child.ended
    ) {
      throw new Error('ACP child changed before it opened')
    }
    try {
      return await child.open(input.signal)
    } catch (error) {
      const failure = acpStartupFailure(child, error)
      if (failure) {
        const refusal = new AgentSessionAcquisitionRefusal(
          `${acpAgentName(child.spec.agent)} requires sign-in`,
          'notSignedIn'
        )
        throw failure.detail ? withProviderDiagnostic(refusal, failure.detail) : refusal
      }
      throw error
    }
  }

  async dispatch(
    input: Parameters<StructuredAgentSessionAdapter['dispatch']>[0]
  ): Promise<AgentSessionDispatchOutcome> {
    const lost = this.children.sessions.get(input.sessionId)
    if (lost && lost.journalClosed !== null) {
      // Protocol loss prevents dispatch even before exit is proven.
      return rejectedAcpDispatch(lost)
    }
    const session = this.live(input.sessionId)
    const prompt = await acpDispatchPrompt(input.body, session)
    if (!Array.isArray(prompt)) {
      return { state: 'rejected', ...prompt }
    }
    if (this.children.sessions.get(input.sessionId) !== session || session.journalClosed !== null) {
      // Attachment reads may outlive the child; this send never reached it.
      return rejectedAcpDispatch(session)
    }
    const { sessionId, fence, signal } = input
    signal?.throwIfAborted()
    input.onInputPreparation?.()
    const optionsApplied = await applyAcpMessageOptions(
      session,
      input.executionOptions,
      (key, value) => this.setOption({ sessionId, fence, key, value, signal }),
      () =>
        this.children.sessions.get(input.sessionId) === session && session.journalClosed === null,
      signal
    )
    if (!optionsApplied) {
      return rejectedAcpDispatch(session)
    }
    input.signal?.throwIfAborted()
    await input.beforeDispatch?.()
    input.signal?.throwIfAborted()
    session.turns.dispatch({
      clientMessageId: input.clientMessageId,
      prompt,
      requestedAt: input.requestedAt ?? this.now()
    })
    // Admission precedes provider confirmation of the send.
    return { state: 'admitted' }
  }

  compact: NonNullable<StructuredAgentSessionAdapter['compact']> = async (input) =>
    this.live(input.sessionId).turns.compact(input.command)

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = async (input) => {
    const session = this.live(input.sessionId)
    // Refuse a stale named turn; a handover with no journal turn can stop the in-flight prompt.
    const liveTurnId = input.resolveLiveTurnId?.() ?? session.lane.openTurnId
    if (input.turnId !== undefined && liveTurnId !== null && input.turnId !== liveTurnId) {
      return { cancelled: false, refusal: { turnNotRunning: true } }
    }
    if (!session.turns.running && session.lane.openTurnId === null && !session.turns.holdsSteers) {
      return { cancelled: false, refusal: { turnNotRunning: true } }
    }
    // The host waits for turn completion or grace expiry, never for the cancel write.
    interruptAcpTurn(session)
    return { cancelled: true }
  }

  awaitStoppedRequestEnd = async (sessionId: string, stoppedAt: number): Promise<void> => {
    const session = this.children.sessions.get(sessionId)
    if (session && isAcpReadySession(session)) {
      await awaitAcpTurnEnd(session, stoppedAt, this.stopGraceMs())
    }
  }

  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (input) =>
    this.live(input.sessionId).prompts.answer(input)

  async setOption(
    input: StructuredAgentSessionSetOptionInput
  ): Promise<Readonly<Record<string, string>>> {
    const session = this.live(input.sessionId)
    const write = session.options.write(input.key, input.value)
    if (!write) {
      throw new AgentSessionOptionRejectedError(
        `${session.spec.agent} offers no session option named ${input.key}`
      )
    }
    session.options.notePick(input.key)
    // Bound option writes so they cannot hold the session queue indefinitely.
    await writeAcpSessionOption(session.connection, session.options, write, {
      key: input.key,
      value: input.value,
      agent: session.spec.agent,
      timeoutMs: this.deps.optionWriteTimeoutMs ?? ACP_OPTION_WRITE_TIMEOUT_MS,
      ...(input.signal ? { signal: input.signal } : {})
    })
    return session.options.reported()
  }

  readOptions = async (input: { sessionId: string; fence: number }) => {
    const session = this.live(input.sessionId)
    return readAcpLiveOptions(session, session.spec.permissionModeConfig?.values)
  }

  readCommands = (sessionId: string) => {
    const session = this.children.sessions.get(sessionId)
    return session && isAcpReadySession(session) ? session.options.readCommands() : undefined
  }

  capturePendingOutput: StructuredAgentSessionAdapter['capturePendingOutput'] = (input) =>
    this.children.capturePendingOutput?.(input)

  holdsDispatch = (sessionId: string): boolean => {
    const session = this.children.sessions.get(sessionId)
    return session ? isAcpReadySession(session) && session.turns.running : false
  }

  holdsLiveProviderProcess = (sessionId: string, generation: string): boolean => {
    const session = this.children.sessions.get(sessionId)
    return session?.acquisitionGeneration === generation && !session.connection.exited
  }

  acknowledgeSessionRelease = (sessionId: string): void => {
    const session = this.children.sessions.get(sessionId)
    if (session?.ended) {
      this.children.sessions.delete(sessionId)
    }
  }

  // Until startup opens the session, the host retains responsibility for held sends.
  heldSends = (sessionId: string): ReadonlySet<string> | undefined =>
    this.children.sessions.get(sessionId)?.turns?.heldSends

  stopBackgroundTasks: NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']> = (
    input
  ) => stopAcpChildren(this.live(input.sessionId), input.fence, input.taskIds, input.acknowledge)

  backgroundTaskStops = (sessionId: string) =>
    acpChildStopCapabilities(this.children.sessions.get(sessionId))

  closeSession = (sessionId: string): Promise<boolean> => this.children.close(sessionId)
  disposeSession = (sessionId: string): Promise<boolean> => this.children.close(sessionId)
  releaseAcquisition = (input: { sessionId: string }) => this.children.close(input.sessionId)
  hasOwnedAcquisition = (sessionId: string): boolean =>
    this.children.sessions.has(sessionId) ||
    this.children.starts.failedSessionIds().includes(sessionId)
  forceCloseSession = (sessionId: string): Promise<boolean> => this.children.stop(sessionId, false)

  async closeAll(): Promise<void> {
    const commands = this.atRestCommands?.closeAll?.()
    const copiedChildren = this.copies.closeAll()
    const { children } = this
    const ids = new Set([...children.sessions.keys(), ...children.starts.failedSessionIds()])
    // The host aborts in-progress starts before this teardown.
    const results = await Promise.allSettled([
      ...[...ids].map((sessionId) => children.stop(sessionId, true)),
      copiedChildren,
      commands
    ])
    const failure = results.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') {
      throw failure.reason
    }
    if (results.some((result) => result.status === 'fulfilled' && result.value === false)) {
      throw new Error('an ACP agent child could not be proven stopped')
    }
  }

  private live(sessionId: string): AcpStructuredSession {
    const session = this.children.sessions.get(sessionId)
    if (!session || !isAcpReadySession(session) || session.journalClosed !== null) {
      throw new Error(`no live ${this.deps.spec.agent} child owns ${sessionId}`)
    }
    return session
  }

  private readonly stopGraceMs = (): number => this.deps.stopGraceMs ?? ACP_STOP_GRACE_MS
  private readonly now = (): number => (this.deps.now ?? Date.now)()
}
