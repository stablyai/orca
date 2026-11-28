import type { AgentSessionExecutionLocation } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { supportsSupervisedProviderChildLocation } from '../../../provider-process/supervised-provider-child-location'
import type { AgentSessionStartFailure } from '../../../native-chat/agent-session-wire/startup/structured-agent-session-start-failure'
import type {
  AgentSessionAcquisition,
  AgentSessionIdleConfirmation,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter,
  StructuredAgentSessionSetOptionInput
} from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { AgentSessionOptionRejectedError } from '../../../native-chat/agent-session-wire/options/structured-agent-session-option-error'
import { waitForPromiseWithSignal } from '../../../../shared/concurrency/abort-signal-reason'
import type { AgentSessionSlashCommand } from '../../../../shared/agent-session/agent-session-wire'
import type {
  AgentSessionMcpOperation,
  AgentSessionMcpResult
} from '../../../../shared/agent-session/options/protocol/agent-session-mcp'
import type { ZcodeStructuredSession } from './zcode-structured-session'
import { ZcodeAcquisitions } from './zcode-structured-session-acquisition'
import { manageZcodeSessionMcp } from '../catalog/zcode-mcp'
import { zcodeCopyConversation, zcodeForkForRewind } from './zcode-structured-session-fork'
import { dispatchZcodeTurn } from './zcode-structured-session-dispatch'
import { changeZcodeThreadGoal } from './zcode-structured-session-goal'
import type { ZcodeStructuredSessionAdapterDeps } from './zcode-structured-session-state'

export class ZcodeStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, ZcodeStructuredSession>()
  private readonly acquisitions: ZcodeAcquisitions
  readonly atRestCommands: StructuredAgentSessionAdapter['atRestCommands']

  constructor(private readonly deps: ZcodeStructuredSessionAdapterDeps) {
    this.atRestCommands = deps.atRestCommands
    this.acquisitions = new ZcodeAcquisitions(deps, this.sessions)
  }

  supportsLocation = (location: AgentSessionExecutionLocation): boolean =>
    supportsSupervisedProviderChildLocation(location)

  supportsCreate: NonNullable<StructuredAgentSessionAdapter['supportsCreate']> = (
    location,
    agent
  ) => agent === 'zcode' && this.supportsLocation(location)

  acquire = (input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> =>
    this.acquisitions.acquire(input)

  open: StructuredAgentSessionAdapter['open'] = (input) => this.acquisitions.open(input)

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
      // The write races its own timeout; the caller's signal (app quit) must cut the wait too.
      const write = waitForPromiseWithSignal(
        session.setOption(input.key, input.value, this.deps.requestTimeoutMs ?? null),
        input.signal
      )
      return await write
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

  /** The applied map a saved pick would produce; undefined falls back to the literal reply. */
  projectOptions: NonNullable<StructuredAgentSessionAdapter['projectOptions']> = (
    sessionId,
    options
  ) => {
    const session = this.sessions.get(sessionId)
    if (!session || session.ended) {
      return undefined
    }
    const applied = session.options.project(options)
    if (!applied) {
      return undefined
    }
    return { models: session.options.live(null).models, options: applied }
  }

  /** The live child's probed skills; undefined (unprobed/unsupported) keeps the client catalog. */
  readCommands = (sessionId: string): AgentSessionSlashCommand[] | undefined => {
    const session = this.sessions.get(sessionId)
    return session && !session.ended ? session.commands : undefined
  }

  /** Live `mcp/list` status reads; resting chats report not-running, writes are unsupported. */
  manageMcp = (
    record: Parameters<NonNullable<StructuredAgentSessionAdapter['manageMcp']>>[0],
    operation: AgentSessionMcpOperation
  ): Promise<AgentSessionMcpResult> => manageZcodeSessionMcp(this.sessions, record, operation)
  // readAccountUsage stays codex-only (its wire type, provider gate and copy are codex-specific);
  // zcode plan usage surfaces through the usage/rate-limit service instead.

  /** A fresh independent text task on an isolated-home backend; absent without naming wiring. */
  get generateText(): StructuredAgentSessionAdapter['generateText'] {
    const runs = this.deps.namingRuns
    return runs
      ? (input) =>
          runs.generate({
            prompt: input.prompt,
            ...(input.shouldExecute ? { shouldExecute: input.shouldExecute } : {})
          })
      : undefined
  }

  stopProviderNaming = (): void => this.deps.namingRuns?.stopAll()

  /** The lane's open turn; a dead child runs nothing, so restored "running" rows sweep clean. */
  liveTurnId: NonNullable<StructuredAgentSessionAdapter['liveTurnId']> = (sessionId) =>
    this.sessions.get(sessionId)?.lane?.openTurnId ?? null

  /** Claim this input's still-unsettled send; its echo or teardown ends the pending window. */
  capturePendingOutput: NonNullable<StructuredAgentSessionAdapter['capturePendingOutput']> = (
    input
  ) => {
    const session = this.sessions.get(input.sessionId)
    if (!session || session.ended) {
      return undefined
    }
    return session.armPendingOutput(input)
  }

  /** Orca's goal changes are one zcode `session/goal` write; the host journals the objective. */
  changeThreadGoal: NonNullable<StructuredAgentSessionAdapter['changeThreadGoal']> = async (
    input
  ) => {
    const session = this.live(input.sessionId)
    const providerSessionId = session.providerSessionId
    if (providerSessionId === null) {
      throw new Error('zcode session is not open yet')
    }
    return changeZcodeThreadGoal({
      connection: session.connection,
      providerSessionId,
      change: input.change,
      replacesGoal: input.replacesGoal,
      timeoutMs: this.deps.requestTimeoutMs ?? null,
      ...(input.signal ? { signal: input.signal } : {})
    })
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
    const liveTurnId = (await input.resolveLiveTurnId?.()) ?? session.lane?.openTurnId ?? null
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
    return Promise.resolve(session.idleConfirmation())
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
    this.acquisitions.startupEnding(sessionId, generation)

  retireStartup = (sessionId: string, generation: string): void => {
    this.acquisitions.retireStartup(sessionId, generation)
  }

  closeSession = (sessionId: string): Promise<boolean> => {
    this.acquisitions.retire(sessionId)
    return this.acquisitions.closeOwned(sessionId)
  }

  disposeSession = this.closeSession

  releaseAcquisition = (input: { sessionId: string }): Promise<boolean> =>
    this.closeSession(input.sessionId)

  forceCloseSession = (sessionId: string): Promise<boolean> =>
    this.acquisitions.closeOwned(sessionId)

  hasOwnedAcquisition = (sessionId: string): boolean => this.sessions.has(sessionId)

  acknowledgeSessionRelease(sessionId: string): void {
    this.acquisitions.acknowledgeSessionRelease(sessionId)
  }

  closeAll = (): Promise<void> => this.acquisitions.closeAll()

  forceClose = (sessionId: string, reason: string): Promise<void> =>
    this.acquisitions.forceClose(sessionId, reason)

  private live(sessionId: string): ZcodeStructuredSession {
    const session = this.sessions.get(sessionId)
    if (!session || session.ended || session.journalClosed !== null) {
      throw new Error(`no live zcode child owns ${sessionId}`)
    }
    return session
  }
}
