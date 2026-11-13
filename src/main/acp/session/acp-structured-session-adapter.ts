import { startAcpStructuredSession } from './start/acp-structured-start'

import type { AgentSessionExecutionLocation } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { AgentSessionAcquisitionExitUnprovenError } from '../../native-chat/agent-session-wire/acquisition/structured-agent-session-acquisition-errors'

import type {
  AgentSessionAcquisition,
  AgentSessionDispatchOutcome as DispatchOutcome,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter as SessionAdapter,
  StructuredAgentSessionSetOptionInput as SetOptionInput
} from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'

import { rejectedAcpDispatch } from '../turns/acp-dispatch-rejection'
import type { AcpStructuredSession } from './acp-structured-session-contract'

import { applyAcpMessageOptions } from '../turns/acp-message-execution-options'
import { AgentSessionOptionRejectedError } from '../../native-chat/agent-session-wire/options/structured-agent-session-option-error'
import * as stop from '../turns/acp-structured-stop'
import { acpDispatchPrompt } from '../turns/acp-prompt-content'
import {
  ACP_STOP_GRACE_MS,
  type AcpStructuredSessionAdapterDeps
} from './acp-structured-session-adapter-deps'
import { readAcpLiveOptions } from '../options/acp-live-options'
import { acpControlsSettled, writeAcpSessionOption } from '../options/acp-session-option-write'
import { acpOptionWriteBound, withAcpModelFallback } from '../turns/acp-model-command'
import {
  acpChildStopCapabilities,
  closeAcpChildSessions,
  stopAcpChildren
} from '../turns/acp-structured-child-stop'
import * as childState from './children/acp-structured-child'
import { AcpStructuredChildren } from './children/acp-structured-child-lifecycle'
import { AcpConversationCopies } from '../conversation-copy/acp-conversation-copies'
import { AcpTextTasks } from '../text-task/acp-text-task'
import { supportsAcpStructuredLocation } from './acp-structured-location-support'
import { acpAcquireFailure } from './start/acp-startup-outcome'
import { openAcpStart } from './start/acp-structured-start-open'
import { admitStructuredAgentSessionInput } from '../../native-chat/agent-session-wire/delivery/structured-agent-session-input-admission'

export class AcpStructuredSessionAdapter implements SessionAdapter {
  readonly atRestCommands: AcpStructuredSessionAdapterDeps['atRestCommands']
  private readonly children: AcpStructuredChildren
  private readonly copies: AcpConversationCopies
  private readonly textTasks: AcpTextTasks
  constructor(private readonly deps: AcpStructuredSessionAdapterDeps) {
    this.atRestCommands = deps.atRestCommands
    this.children = new AcpStructuredChildren(deps)
    this.copies = new AcpConversationCopies(deps)
    this.textTasks = new AcpTextTasks(deps)
  }

  generateText: NonNullable<SessionAdapter['generateText']> = (input) =>
    this.textTasks.generate(input)

  copyConversation: NonNullable<SessionAdapter['copyConversation']> = (input) =>
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
      return await startAcpStructuredSession(
        this.deps,
        this.children,
        { ...input, signal: attempt.signal },
        attempt,
        this.now,
        this.graceMs
      )
    } catch (error) {
      throw acpAcquireFailure(error)
    } finally {
      this.children.starts.end(attempt)
      gate?.leave()
    }
  }

  open: NonNullable<SessionAdapter['open']> = (input) => openAcpStart(this.children, input)

  startupEnding: NonNullable<SessionAdapter['startupEnding']> = (sessionId, generation) =>
    this.children.endings.get(sessionId, generation)

  retireStartup: NonNullable<SessionAdapter['retireStartup']> = (sessionId, generation) =>
    this.children.endings.retire(sessionId, generation)

  async dispatch(input: Parameters<SessionAdapter['dispatch']>[0]): Promise<DispatchOutcome> {
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
    return withAcpModelFallback(session, this.writeBound(session, signal), async (fallback) => {
      const optionsApplied = await applyAcpMessageOptions(
        session,
        input.executionOptions,
        (key, value) => this.setOption({ sessionId, fence, key, value, signal }),
        () =>
          this.children.sessions.get(input.sessionId) === session && session.journalClosed === null,
        signal,
        fallback.command
      )
      if (!optionsApplied) {
        return rejectedAcpDispatch(session)
      }
      await acpControlsSettled(session, signal)
      input.signal?.throwIfAborted()
      await input.beforeDispatch?.()
      input.signal?.throwIfAborted()
      const commit = fallback.admitting(() =>
        session.turns.dispatch({
          clientMessageId: input.clientMessageId,
          prompt,
          requestedAt: input.requestedAt ?? this.now()
        })
      )
      await admitStructuredAgentSessionInput(input.admitFreshInput, commit)
      // Admission precedes provider confirmation of the send.
      return { state: 'admitted' }
    })
  }

  compact: NonNullable<SessionAdapter['compact']> = async (input) => {
    const session = this.live(input.sessionId)
    await acpControlsSettled(session)
    return session.turns.compact(input.command)
  }

  cancelTurn: SessionAdapter['cancelTurn'] = async (input) => {
    const session = this.live(input.sessionId)
    // Refuse a stale named turn; a handover with no journal turn can stop the in-flight prompt.
    const liveTurnId = input.resolveLiveTurnId?.() ?? session.lane.openTurnId
    if (input.turnId !== undefined && liveTurnId !== null && input.turnId !== liveTurnId) {
      return { cancelled: false, refusal: { turnNotRunning: true } }
    }
    // A chat Stop ends subagents too, even when the root turn ended just before it arrived;
    // a permission card's Cancel stops only its own turn.
    if (!input.prompt) {
      closeAcpChildSessions(session)
    }
    if (!stop.acpStopHasWork(session)) {
      return { cancelled: false, refusal: { turnNotRunning: true } }
    }
    // The host waits for turn completion or grace expiry, never for the cancel write.
    stop.interruptAcpTurn(session)
    return { cancelled: true }
  }

  private readonly graceMs = (): number => this.deps.stopGraceMs ?? ACP_STOP_GRACE_MS

  awaitStoppedRequestEnd = stop.requestEndWait((id) => this.children.sessions.get(id), this.graceMs)

  settlePermissionTransition = stop.acpPermissionTransition((id) => this.live(id), this.graceMs)

  answerPrompt: SessionAdapter['answerPrompt'] = (input) =>
    this.live(input.sessionId).prompts.answer(input)

  async setOption(input: SetOptionInput) {
    const session = this.live(input.sessionId)
    const write = session.options.write(input.key, input.value)
    if (!write) {
      throw new AgentSessionOptionRejectedError(
        `${session.spec.agent} offers no session option named ${input.key}`
      )
    }
    session.options.notePick(input.key)
    // Bound option writes so they cannot hold the session queue indefinitely.
    const bound = { ...this.writeBound(session, input.signal), key: input.key, value: input.value }
    await writeAcpSessionOption(session.connection, session.options, write, bound)
    return session.options.reported()
  }

  private writeBound = (session: AcpStructuredSession, signal?: AbortSignal) =>
    acpOptionWriteBound(this.deps, session, signal, (e) => this.children.connectionLost(session, e))

  canSetOptionWhileIdle = (input: SetOptionInput): boolean =>
    childState.canSetAcpOptionWhileIdle(this.children.sessions.get(input.sessionId), input)

  readOptions = async (input: { sessionId: string; fence: number }) => {
    const session = this.live(input.sessionId)
    return readAcpLiveOptions(session, session.permissionModes)
  }

  readCommands = (sessionId: string) => {
    const session = this.children.sessions.get(sessionId)
    return session && childState.isAcpReadySession(session)
      ? session.options.readCommands()
      : undefined
  }

  capturePendingOutput: SessionAdapter['capturePendingOutput'] = (input) =>
    this.children.capturePendingOutput?.(input)

  holdsDispatch = (sessionId: string): boolean => {
    const session = this.children.sessions.get(sessionId)
    return session ? childState.isAcpReadySession(session) && session.turns.running : false
  }

  confirmIdle: NonNullable<SessionAdapter['confirmIdle']> = (sessionId) => {
    const session = this.children.sessions.get(sessionId)
    // OMP cannot prove that a finished parent has no background work or pending results.
    return session?.spec.agent === 'omp' && !session.connection.exited
      ? Promise.resolve('unknown')
      : undefined
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

  stopBackgroundTasks: NonNullable<SessionAdapter['stopBackgroundTasks']> = (input) =>
    stopAcpChildren(this.live(input.sessionId), input.fence, input.taskIds, input.acknowledge)

  backgroundTaskStops = (sessionId: string) =>
    acpChildStopCapabilities(this.children.sessions.get(sessionId))

  // A released or closed session's start has no reader left for its ending.
  closeSession = (sessionId: string): Promise<boolean> => {
    this.children.endings.retire(sessionId)
    return this.children.close(sessionId)
  }
  disposeSession = this.closeSession
  releaseAcquisition = (input: { sessionId: string }) => this.closeSession(input.sessionId)
  hasOwnedAcquisition = (sessionId: string): boolean =>
    this.children.sessions.has(sessionId) ||
    this.children.starts.failedSessionIds().includes(sessionId)
  forceCloseSession = (sessionId: string): Promise<boolean> => this.children.close(sessionId, false)

  async closeAll(): Promise<void> {
    this.children.endings.clear()
    await this.children.closeAll([
      this.atRestCommands?.closeAll?.(),
      this.copies.closeAll(),
      this.textTasks.closeAll()
    ])
  }

  private live(sessionId: string): AcpStructuredSession {
    const session = this.children.sessions.get(sessionId)
    if (!session || !childState.isAcpReadySession(session) || session.journalClosed !== null) {
      throw new Error(`no live ${this.deps.spec.agent} child owns ${sessionId}`)
    }
    return session
  }

  private readonly now = (): number => (this.deps.now ?? Date.now)()
}
