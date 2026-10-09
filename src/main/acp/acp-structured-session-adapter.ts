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
  AgentSessionAcquisitionRootExitObservedError,
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
import { acpAgentName, acquireAcpStructuredSession } from './acp-structured-acquire'
import {
  closeAcpSessionJournal,
  endAcpStructuredSession,
  type AcpStructuredSession
} from './acp-structured-session'
import {
  ProviderAcquisitionStarts,
  type ProviderStartAttempt
} from '../provider-process/provider-acquisition-starts'
import { waitForAcpExit, type AcpStructuredConnection } from './acp-structured-connection'
import { AcpConnectionClosedError } from './acp-errors'
import { awaitAcpTurnEnd, interruptAcpTurn, windDownAcpTurn } from './acp-structured-stop'
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

export class AcpStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  /** Live children, and ones whose exit is not yet proven; a proven exit removes its entry. */
  private readonly sessions = new Map<string, AcpStructuredSession>()
  private readonly starts = new ProviderAcquisitionStarts<AcpStructuredConnection>()

  constructor(private readonly deps: AcpStructuredSessionAdapterDeps) {}

  /** Restart recovery's evidence; null for an agent whose own store Orca cannot read. */
  providerHistoryWindow: NonNullable<StructuredAgentSessionAdapter['providerHistoryWindow']> = ({
    identity
  }) => readAcpRecoveryHistory(this.deps, identity)

  // The child runs on this runtime's own machine; Windows needs process start-time proof.
  supportsLocation = (location: AgentSessionExecutionLocation): boolean =>
    supportsSupervisedProviderChildLocation(location, this.deps.isWindowsProcessStartTimeAvailable)

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> {
    const sessionId = input.identity.sessionId
    const attempt = this.starts.begin(input.signal)
    try {
      if (!(await this.stop(sessionId))) {
        throw new AgentSessionAcquisitionExitUnprovenError(
          new Error(
            `the previous ${this.deps.spec.agent} child for ${sessionId} could not be stopped`
          )
        )
      }
      return await this.start(input, attempt)
    } finally {
      this.starts.end(attempt)
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
        track: (connection) => this.starts.track(attempt, connection),
        onExit: (session) => {
          if (session && this.sessions.get(sessionId) === session) {
            this.finish(session, this.now())
          }
        },
        onConnectionLost: (session, error) => this.connectionLost(session, error),
        onSettled: (settlement) => this.deps.onDispatchSettledLate?.({ sessionId, ...settlement }),
        forceClose: (id) => void this.forceCloseSession(id)
      })
      if (attempt.signal.aborted) {
        session.lane.dispose()
        throw new Error('closed while starting')
      }
      this.sessions.set(sessionId, session)
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
        this.starts.retainFailed(sessionId, connection)
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
    const lost = this.sessions.get(input.sessionId)
    if (lost && lost.journalClosed !== null) {
      // The connection broke and the exit is not yet proven: the message never left Orca.
      return this.rejected(lost, 'providerExited')
    }
    const session = this.live(input.sessionId)
    const prompt = await acpDispatchPrompt(input.body, session)
    if (!Array.isArray(prompt)) {
      return { state: 'rejected', ...prompt }
    }
    if (this.sessions.get(input.sessionId) !== session || session.journalClosed !== null) {
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

  // Stop is a session boundary for every ACP agent, as in the common pattern: a cancel ends only
  // the running turn, and work the agent moved to the background could begin a turn of its own.
  // The next send reloads the session.
  stopEndsSession = (): boolean => true

  awaitStoppedRequestEnd = async (sessionId: string, stoppedAt: number): Promise<void> => {
    const session = this.sessions.get(sessionId)
    if (session) {
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
    return withLiveCatalogListing(options.read(), options.configuredDefault())
  }

  readOptionRestoreFailures = (sessionId: string): readonly string[] =>
    this.sessions.get(sessionId)?.restoreSkipped ?? []

  readCommands = (sessionId: string) => this.sessions.get(sessionId)?.options.readCommands()

  stopBackgroundTasks: NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']> = (
    input
  ) => stopAcpChildren(this.live(input.sessionId), input.fence, input.taskIds, () => this.now())

  backgroundTaskStops: NonNullable<StructuredAgentSessionAdapter['backgroundTaskStops']> = (
    sessionId
  ) => acpChildStopCapabilities(this.sessions.get(sessionId))

  closeSession = (sessionId: string): Promise<boolean> => this.close(sessionId)
  disposeSession = (sessionId: string): Promise<boolean> => this.close(sessionId)
  releaseAcquisition = (input: { sessionId: string }) => this.close(input.sessionId)
  /** After a sink failure: the exit is recovered as unexpected. */
  forceCloseSession = (sessionId: string): Promise<boolean> => this.stop(sessionId, false)

  async closeAll(): Promise<void> {
    const ids = new Set([...this.sessions.keys(), ...this.starts.failedSessionIds()])
    // A start still under way is the host's to abort: its teardown does, before this runs.
    const proven = await Promise.all([...ids].map((sessionId) => this.stop(sessionId, true)))
    if (proven.includes(false)) {
      throw new Error('an ACP agent child could not be proven stopped')
    }
  }

  /** A requested close: proven by the root's exit; a tree not proven gone is the caller's to report. */
  private async close(sessionId: string): Promise<boolean> {
    const connection = this.sessions.get(sessionId)?.connection
    const closed = await this.stop(sessionId, true)
    if (closed && connection?.processTreeUnproven) {
      throw new AgentSessionAcquisitionRootExitObservedError(
        new Error(
          `${this.deps.spec.agent} ACP agent exited, but its process tree was not proven gone`
        )
      )
    }
    return closed
  }

  /** True only once every child is proven gone, or when this adapter runs none for the session:
   *  a failed start's child, and the session's own. */
  private async stop(sessionId: string, requested = true): Promise<boolean> {
    const [failedStart, session] = await Promise.all([
      this.starts.stopFailed(sessionId),
      this.stopSession(sessionId, requested)
    ])
    return failedStart && session
  }

  private async stopSession(sessionId: string, requested: boolean): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session || session.ended) {
      return true
    }
    if (requested && session.journalClosed === null) {
      // A close, dispose or quit ends a running turn as a Stop does before the child goes.
      session.closeRequested = true
      await windDownAcpTurn(session, this.stopGraceMs())
      if (session.ended) {
        return true
      }
    }
    // A connection loss already decided why the child ends; a later stop does not relabel it.
    if (session.journalClosed === null) {
      session.closeRequested ||= requested
      session.lane.flush()
    }
    const proven = await session.connection.close()
    if (proven) {
      this.finish(session, session.exitObservedAt ?? this.now())
    }
    return proven
  }

  /** The child's exit is proven: the host hears it, and nothing of the child stays here. */
  private finish(session: AcpStructuredSession, observedAt: number): void {
    endAcpStructuredSession(session, observedAt, this.deps.onEvent)
    if (this.sessions.get(session.sessionId) === session) {
      this.sessions.delete(session.sessionId)
    }
  }

  /** The connection broke while the child may still run: nothing more it says can be journaled, so
   *  the journal closes now and the child is stopped; the host hears `ended` once that is proven. */
  private connectionLost(session: AcpStructuredSession | null, error: Error): void {
    if (
      !session ||
      this.sessions.get(session.sessionId) !== session ||
      session.journalClosed !== null
    ) {
      return
    }
    closeAcpSessionJournal(
      session,
      `${session.spec.agent} ACP connection closed: ${error.message || error.name}`
    )
    void this.stop(session.sessionId, false)
  }

  private rejected(
    session: AcpStructuredSession,
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
    const session = this.sessions.get(sessionId)
    if (!session || session.journalClosed !== null) {
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
