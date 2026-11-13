import type { AgentSessionExecutionLocation } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { supportsSupervisedProviderChildLocation } from '../../../provider-process/supervised-provider-child-location'
import { ProviderAcquisitionStarts } from '../../../provider-process/provider-acquisition-starts'
import {
  agentSessionAcquireFailure,
  AgentSessionStartEndings,
  type AgentSessionStartAnswer,
  type AgentSessionStartFailure
} from '../../../native-chat/agent-session-wire/startup/structured-agent-session-start-failure'
import type { StructuredAgentSessionProviderOpenInput } from '../../../native-chat/agent-session-wire/startup/structured-agent-session-provider-open-contract'
import { AgentSessionAcquisitionExitUnprovenError } from '../../../native-chat/agent-session-wire/acquisition/structured-agent-session-acquisition-errors'
import {
  launchPreparationFailure,
  AgentSessionPreSpawnError
} from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import type {
  AgentSessionAcquisition,
  AgentSessionIdleConfirmation,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter,
  StructuredAgentSessionSetOptionInput
} from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { AgentSessionOptionRejectedError } from '../../../native-chat/agent-session-wire/options/structured-agent-session-option-error'
import { stopAgentSessionProviderRoot } from '../../../native-chat/agent-session-wire/termination/structured-agent-session-provider-exit-proof'
import type { ZcodeStructuredSession } from './zcode-structured-session'
import { startZcodeStructuredSession, zcodeStartFailure } from './zcode-structured-start'
import { zcodeCopyConversation, zcodeForkForRewind } from './zcode-structured-session-fork'
import { dispatchZcodeTurn } from './zcode-structured-session-dispatch'
import { mintZcodeAcquisitionGeneration } from './zcode-structured-session-state'
import { ZcodeAppServerRequestError } from '../../app-server/zcode-app-server-errors'

/** zcode's own request refusals are final answers; exits are reported separately. */
const zcodeStartAnswer: AgentSessionStartAnswer = (cause) =>
  cause instanceof ZcodeAppServerRequestError ? 'final' : undefined
import type { ZcodeStructuredSessionAdapterDeps } from './zcode-structured-session-state'

export class ZcodeStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, ZcodeStructuredSession>()
  private readonly starts = new ProviderAcquisitionStarts<never>()
  private readonly endings = new AgentSessionStartEndings()
  private readonly retiring = new Set<Promise<void>>()

  constructor(private readonly deps: ZcodeStructuredSessionAdapterDeps) {}

  supportsLocation = (location: AgentSessionExecutionLocation): boolean =>
    supportsSupervisedProviderChildLocation(location)

  supportsCreate: NonNullable<StructuredAgentSessionAdapter['supportsCreate']> = (
    location,
    agent
  ) => agent === 'zcode' && this.supportsLocation(location)

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> {
    const sessionId = input.identity.sessionId
    const attempt = this.starts.begin(input.signal)
    try {
      if (!(await this.starts.stopFailed(sessionId))) {
        throw new AgentSessionAcquisitionExitUnprovenError(
          new Error('the previous zcode start has not exited')
        )
      }
      this.acknowledgeSessionRelease(sessionId)
      // An in-flight retirement still holds the old session row; waiting keeps the ownership
      // check honest instead of failing a re-acquire that arrives a moment too early.
      await Promise.all(Array.from(this.retiring))
      if (this.sessions.has(sessionId)) {
        throw new AgentSessionPreSpawnError(new Error('zcode session already owns a child'))
      }
      const generation = mintZcodeAcquisitionGeneration(this.deps)
      this.endings.admit(sessionId, generation)
      let launch
      try {
        launch = await this.deps.resolveLaunch({
          identity: input.identity,
          spawnToken: input.spawnToken,
          ...(input.permissionMode ? { permissionMode: input.permissionMode } : {})
        })
      } catch (error) {
        throw launchPreparationFailure(error)
      }
      const started = await startZcodeStructuredSession({
        acquire: input,
        deps: this.deps,
        launch,
        generation,
        events: input.events,
        forceClose: (id, reason) => void this.forceClose(id, reason),
        onSettled: (settlement) => this.deps.onDispatchSettledLate?.({ sessionId, ...settlement }),
        recordStartFailure: (failure) => this.endings.record(sessionId, generation, failure)
      })
      this.sessions.set(sessionId, started.session)
      return { process: started.process, acquisitionGeneration: generation }
    } catch (error) {
      this.endings.retire(sessionId, 'acquire')
      throw agentSessionAcquireFailure(error, zcodeStartAnswer)
    } finally {
      this.starts.end(attempt)
    }
  }

  open = async (input: StructuredAgentSessionProviderOpenInput) => {
    const session = this.sessions.get(input.sessionId)
    try {
      if (!session || session.ended) {
        throw (
          this.endings.get(input.sessionId, input.acquisitionGeneration) ??
          new Error(`no live zcode child owns ${input.sessionId}`)
        )
      }
      return await session.open(input.signal)
    } catch (error) {
      throw zcodeStartFailure(
        error,
        session?.connection.closeResult?.root === 'exited' && !session.closeRequested
      )
    }
  }

  dispatch: StructuredAgentSessionAdapter['dispatch'] = async (input) => {
    const session = this.live(input.sessionId)
    return dispatchZcodeTurn(session, input, this.deps.requestTimeoutMs ?? null)
  }

  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = async (input) => {
    const session = this.live(input.sessionId)
    await session.prompts.answer({
      itemId: input.itemId,
      response: input.response,
      commit: input.commit
    })
  }

  /** Every zcode option write is a plain RPC; any of them may land while the child is idle. */
  canSetOptionWhileIdle: (input: StructuredAgentSessionSetOptionInput) => boolean = () => true

  /** Fork/rewind resolve against persisted sessions over a disposable backend, live child or not. */
  rewindSupport = (): { supported: true } => ({ supported: true })

  copyConversation: NonNullable<StructuredAgentSessionAdapter['copyConversation']> = (input) =>
    zcodeCopyConversation(this.deps, input)

  forkForRewind: NonNullable<StructuredAgentSessionAdapter['forkForRewind']> = (input) =>
    zcodeForkForRewind(this.deps, input)

  async setOption(input: StructuredAgentSessionSetOptionInput) {
    const session = this.live(input.sessionId)
    if (!session.providerSessionId) {
      throw new AgentSessionOptionRejectedError('zcode session is not open yet')
    }
    try {
      return await session.setOption(input.key, input.value, this.deps.requestTimeoutMs ?? null)
    } catch (error) {
      throw new AgentSessionOptionRejectedError(
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  readOptions: NonNullable<StructuredAgentSessionAdapter['readOptions']> = async (input) => {
    const session = this.live(input.sessionId)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
    const read = (await session.connection
      .request('session/read', { sessionId: session.providerSessionId })
      .catch(() => null)) as { projection?: unknown; settings?: unknown } | null
    if (read?.settings) {
      session.options.adoptProjectionSettings(read.settings)
    }
    return session.options.live(null)
  }

  compact: NonNullable<StructuredAgentSessionAdapter['compact']> = async (input) => {
    const session = this.live(input.sessionId)
    if (!session.providerSessionId) {
      throw new Error('zcode session is not open yet')
    }
    session.lane?.beginCommand(input.command)
    session.startCompaction(input.command.turnId)
    try {
      await session.connection.request(
        'session/compact',
        { sessionId: session.providerSessionId },
        { timeoutMs: this.deps.requestTimeoutMs ?? null }
      )
    } catch (error) {
      session.lane?.forgetCommand(input.command.turnId)
      session.cancelCompaction()
      throw error
    }
    return { state: 'accepted' as const, providerIdentity: null }
  }

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = async (input) => {
    const session = this.sessions.get(input.sessionId)
    if (!session || session.ended) {
      return { cancelled: false }
    }
    const liveTurnId = input.resolveLiveTurnId?.() ?? session.lane?.openTurnId ?? null
    if (liveTurnId === null || (input.turnId !== undefined && input.turnId !== liveTurnId)) {
      return { cancelled: false, refusal: { turnNotRunning: true } }
    }
    await session.turns.stop()
    // The backend declines cancelled prompts itself; open cards stop being actionable here.
    session.prompts.withdrawAll()
    return { cancelled: true, turnId: liveTurnId }
  }

  awaitStoppedRequestEnd = async (sessionId: string, at: number): Promise<void> => {
    const session = this.sessions.get(sessionId)
    const turn = session?.lane?.openTurnId
    if (!session || !turn) {
      return
    }
    await Promise.race([
      session.lane!.whenTurnLeaves(turn),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, at + 2_000 - Date.now()))
        timer.unref()
      })
    ])
  }

  confirmIdle = (sessionId: string): Promise<AgentSessionIdleConfirmation> | undefined => {
    const session = this.sessions.get(sessionId)
    if (!session || session.ended) {
      return undefined
    }
    const verdict: AgentSessionIdleConfirmation =
      session.turns.heldSends.size > 0 || session.prompts.size > 0 ? 'busy' : 'idle'
    return Promise.resolve(verdict)
  }

  holdsDispatch = (sessionId: string): boolean => {
    const session = this.sessions.get(sessionId)
    return (session?.turns.heldSends.size ?? 0) > 0 || session?.dispatchPending === true
  }

  heldSends = (sessionId: string): ReadonlySet<string> | undefined => {
    const session = this.sessions.get(sessionId)
    return session && !session.ended ? session.turns.heldSends : undefined
  }

  holdsLiveProviderProcess = (sessionId: string, generation: string): boolean => {
    const session = this.sessions.get(sessionId)
    return session?.acquisitionGeneration === generation && !session.ended
  }

  startupEnding = (sessionId: string, generation: string): AgentSessionStartFailure | undefined =>
    this.endings.get(sessionId, generation)

  retireStartup = (sessionId: string, generation: string): void => {
    this.endings.retire(sessionId, generation)
  }

  closeSession = (sessionId: string): Promise<boolean> => {
    this.endings.retire(sessionId)
    return this.close(sessionId)
  }

  disposeSession = this.closeSession

  releaseAcquisition = (input: { sessionId: string }): Promise<boolean> =>
    this.closeSession(input.sessionId)

  forceCloseSession = (sessionId: string): Promise<boolean> => this.close(sessionId)

  hasOwnedAcquisition = (sessionId: string): boolean => this.sessions.has(sessionId)

  acknowledgeSessionRelease(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session?.ended) {
      return
    }
    // Ownership survives until close proves the child exited; release then reports honestly.
    const retirement = Promise.resolve(
      session
        .close()
        .catch(() => false)
        .then((stopped) => {
          if (stopped) {
            this.sessions.delete(sessionId)
          }
        })
    )
    this.retiring.add(retirement)
    void retirement.then(() => this.retiring.delete(retirement))
  }

  async closeAll(): Promise<void> {
    this.endings.clear()
    await Promise.all(
      [...this.sessions.keys()].map((sessionId) =>
        stopAgentSessionProviderRoot(() => this.closeSession(sessionId))
      )
    )
  }

  private async close(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return true
    }
    const stopped = await session.close().catch(() => false)
    if (stopped) {
      this.sessions.delete(sessionId)
    }
    return stopped
  }

  private forceClose = async (sessionId: string, reason: string): Promise<void> => {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }
    session.failureClose = reason
    session.markJournalClosed(reason)
    session.markEnded(Date.now())
    const stopped = await session.close().catch(() => false)
    if (stopped) {
      this.sessions.delete(sessionId)
    }
  }

  private live(sessionId: string): ZcodeStructuredSession {
    const session = this.sessions.get(sessionId)
    if (!session || session.ended || session.journalClosed !== null) {
      throw new Error(`no live zcode child owns ${sessionId}`)
    }
    return session
  }
}
