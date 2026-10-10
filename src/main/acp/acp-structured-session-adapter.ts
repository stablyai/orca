// A structured chat over the Agent Client Protocol: one adapter per registered ACP agent, which
// the router drives like the Claude and Codex lanes. Rewind and goals are absent, so the chat hides
// them; compaction is the agent's own `/compact` prompt, for an agent whose launch spec offers it.

import { randomUUID } from 'node:crypto'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionPreSpawnError,
  isAgentSessionPreSpawnError,
  type AgentSessionAcquisition,
  type AgentSessionDispatchOutcome,
  type StructuredAgentSessionAcquireInput,
  type StructuredAgentSessionAdapter,
  type StructuredAgentSessionSetOptionInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'
import { withObservedProviderExit } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import { acpAgentName } from './acp-structured-agent-definitions'
import { acquireAcpStructuredSession } from './acp-structured-acquire'
import type { AcpStructuredSession } from './acp-structured-session'
import type { ProviderStartAttempt } from '../provider-process/provider-acquisition-starts'
import { waitForAcpExit, type AcpStructuredConnection } from './acp-structured-connection'
import { AcpConnectionClosedError } from './acp-errors'
import { awaitAcpTurnEnd, interruptAcpTurn } from './acp-structured-stop'
import { acpDispatchPrompt } from './acp-prompt-content'
import {
  ACP_OPTION_WRITE_TIMEOUT_MS,
  ACP_STOP_GRACE_MS,
  type AcpStructuredSessionAdapterDeps
} from './acp-structured-session-adapter-deps'
import { writeAcpSessionOption } from './acp-structured-options'
import { readAcpRecoveryHistory } from './acp-recovery-history'
import { withLiveCatalogListing } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { stopAcpChildren, acpChildStopCapabilities } from './acp-structured-child-stop'
import type { AcpStructuredChild } from './acp-structured-child'
import { AcpStructuredChildren } from './acp-structured-child-lifecycle'

export class AcpStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly children: AcpStructuredChildren
  constructor(private readonly deps: AcpStructuredSessionAdapterDeps) {
    this.children = new AcpStructuredChildren(deps)
  }

  /** Restart recovery's evidence; null for an agent whose own store Orca cannot read. */
  providerHistoryWindow: NonNullable<StructuredAgentSessionAdapter['providerHistoryWindow']> = ({
    identity
  }) => readAcpRecoveryHistory(this.deps, identity)

  // The child runs on this runtime's own machine; Windows needs process start-time proof.
  supportsLocation = (location: AgentSessionExecutionLocation): boolean =>
    supportsSupervisedProviderChildLocation(location, this.deps.isWindowsProcessStartTimeAvailable)

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> {
    const sessionId = input.identity.sessionId
    const attempt = this.children.starts.begin(input.signal)
    try {
      if (!(await this.children.stop(sessionId))) {
        throw new AgentSessionAcquisitionExitUnprovenError(
          new Error(
            `the previous ${this.deps.spec.agent} child for ${sessionId} could not be stopped`
          )
        )
      }
      return await this.start(input, attempt)
    } finally {
      this.children.starts.end(attempt)
    }
  }

  private async start(
    input: StructuredAgentSessionAcquireInput,
    attempt: ProviderStartAttempt<AcpStructuredConnection>
  ): Promise<AgentSessionAcquisition> {
    const sessionId = input.identity.sessionId
    const generation = this.deps.mintGeneration?.() ?? randomUUID()
    try {
      const { acquisition, session, initialize } = await acquireAcpStructuredSession({
        acquire: input,
        deps: this.deps,
        generation,
        abandoned: () => attempt.signal.aborted,
        track: (connection) => this.children.starts.track(attempt, connection),
        onExit: (session) => {
          if (session && this.children.sessions.get(sessionId) === session) {
            this.children.finish(session, this.now())
          }
        },
        onConnectionLost: (session, error) => this.children.connectionLost(session, error),
        onReady: (ready, event) => {
          const child = this.children.sessions.get(sessionId)
          if (
            child?.phase !== 'starting' ||
            child.ended ||
            child.closeRequested ||
            child.journalClosed !== null
          ) {
            return
          }
          this.children.sessions.set(sessionId, ready)
          this.deps.onEvent?.(event)
        },
        onSettled: (settlement) => this.deps.onDispatchSettledLate?.({ sessionId, ...settlement }),
        forceClose: (id) => void this.forceCloseSession(id)
      })
      if (attempt.signal.aborted) {
        session.dispose()
        throw new Error('closed while starting')
      }
      this.children.sessions.set(sessionId, session)
      void initialize().catch((error: unknown) => this.children.startupFailed(session, error))
      return acquisition
    } catch (error) {
      const { connection } = attempt
      if (connection && error instanceof AcpConnectionClosedError) {
        // A protocol that broke before the exit was seen: wait (bounded) for that exit, so the
        // failure carries the agent's last words, as a running session's end does.
        await waitForAcpExit(connection, this.stopGraceMs(), attempt.signal)
      }
      // Checked before the close below, which would make any exit look like one Orca asked for.
      const exitedOnItsOwn = connection?.exited === true && !attempt.signal.aborted
      if (connection && !(await connection.close().catch(() => false))) {
        // Kept, so the next start or quit closes this same process again; no second one spawns.
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
        // The agent's own last words are what a person can act on.
        throw new AgentSessionAcquisitionExitProvenError(
          withObservedProviderExit(
            new Error(connection.stderrTail() || String(error), { cause: error })
          )
        )
      }
      throw error
    }
  }

  async dispatch(input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    fence: number
    requestedAt?: number
    beforeDispatch?: () => Promise<void>
  }): Promise<AgentSessionDispatchOutcome> {
    const lost = this.children.sessions.get(input.sessionId)
    if (lost && lost.journalClosed !== null) {
      // The connection broke and the exit is not yet proven: the message never left Orca.
      return this.rejected(lost, 'providerExited')
    }
    const session = this.live(input.sessionId)
    const prompt = await acpDispatchPrompt(input.body, session)
    if (!Array.isArray(prompt)) {
      return { state: 'rejected', ...prompt }
    }
    if (this.children.sessions.get(input.sessionId) !== session || session.journalClosed !== null) {
      // The child ended while its attachments were read: nothing left Orca.
      return this.rejected(session, 'providerExited')
    }
    await input.beforeDispatch?.()
    session.turns.dispatch({
      clientMessageId: input.clientMessageId,
      prompt,
      requestedAt: input.requestedAt ?? this.now()
    })
    // The write is the admission; the agent's first event for the turn settles it.
    return { state: 'admitted' }
  }

  compact: NonNullable<StructuredAgentSessionAdapter['compact']> = async (input) =>
    this.live(input.sessionId).turns.compact(input.command)

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = async (input) => {
    const session = this.live(input.sessionId)
    // The Stop ends the child unless it is declined here. Claude's rule: a Stop naming an ended turn
    // while another one is live stops nothing; in the gap before a follow-up's turn opens, which no
    // client can name, it stops what is in flight.
    const liveTurnId = input.resolveLiveTurnId?.() ?? session.lane.openTurnId
    if (input.turnId !== undefined && liveTurnId !== null && input.turnId !== liveTurnId) {
      return { cancelled: false, refusal: { turnNotRunning: true } }
    }
    if (!session.turns.running && session.lane.openTurnId === null && !session.turns.holdsSteers) {
      return { cancelled: false, refusal: { turnNotRunning: true } }
    }
    // The agent may end its turn its own way; the host ends the process once that lands or the
    // grace runs out (`awaitStoppedRequestEnd`), never waiting on the cancel's write.
    interruptAcpTurn(session)
    return { cancelled: true }
  }

  awaitStoppedRequestEnd = async (sessionId: string, stoppedAt: number): Promise<void> => {
    const session = this.children.sessions.get(sessionId)
    if (session?.phase === 'ready') {
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
      throw new Error(`${session.spec.agent} offers no session option named ${input.key}`)
    }
    session.options.notePick(input.key)
    // Bounded, and abandoned by a close or Stop: the session's queue waits on it.
    await writeAcpSessionOption(session.connection, session.options, write, {
      agent: session.spec.agent,
      timeoutMs: this.deps.optionWriteTimeoutMs ?? ACP_OPTION_WRITE_TIMEOUT_MS,
      ...(input.signal ? { signal: input.signal } : {})
    })
    return session.options.reported()
  }

  readOptions = async (input: { sessionId: string; fence: number }) => {
    const { options } = this.live(input.sessionId)
    // Only the start says what the config resolved: the session may have moved since.
    return withLiveCatalogListing(options.read())
  }

  readCommands = (sessionId: string) => {
    const session = this.children.sessions.get(sessionId)
    return session?.phase === 'ready' ? session.options.readCommands() : undefined
  }

  holdsDispatch = (sessionId: string): boolean => {
    const session = this.children.sessions.get(sessionId)
    return session?.phase === 'ready' && session.turns.running
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

  stopBackgroundTasks: NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']> = (
    input
  ) => stopAcpChildren(this.live(input.sessionId), input.fence, input.taskIds, () => this.now())

  backgroundTaskStops: NonNullable<StructuredAgentSessionAdapter['backgroundTaskStops']> = (
    sessionId
  ) => acpChildStopCapabilities(this.children.sessions.get(sessionId))

  closeSession = (sessionId: string): Promise<boolean> => this.children.close(sessionId)
  disposeSession = (sessionId: string): Promise<boolean> => this.children.close(sessionId)
  releaseAcquisition = (input: { sessionId: string }) => this.children.close(input.sessionId)
  /** After a sink failure: the exit is recovered as unexpected. */
  forceCloseSession = (sessionId: string): Promise<boolean> => this.children.stop(sessionId, false)

  async closeAll(): Promise<void> {
    const ids = new Set([
      ...this.children.sessions.keys(),
      ...this.children.starts.failedSessionIds()
    ])
    // A start still under way is the host's to abort: its teardown does, before this runs.
    const proven = await Promise.all(
      [...ids].map((sessionId) => this.children.stop(sessionId, true))
    )
    if (proven.includes(false)) {
      throw new Error('an ACP agent child could not be proven stopped')
    }
  }

  private rejected(
    session: AcpStructuredChild,
    kind: 'providerExited'
  ): AgentSessionDispatchOutcome {
    return {
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact(kind), {
        surface: 'rejection',
        agentName: acpAgentName(session.spec.agent)
      })
    }
  }

  private live(sessionId: string): AcpStructuredSession {
    const session = this.children.sessions.get(sessionId)
    if (session?.phase !== 'ready' || session.journalClosed !== null) {
      throw new Error(`no live ${this.deps.spec.agent} child owns ${sessionId}`)
    }
    return session
  }

  private stopGraceMs(): number {
    return this.deps.stopGraceMs ?? ACP_STOP_GRACE_MS
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}
