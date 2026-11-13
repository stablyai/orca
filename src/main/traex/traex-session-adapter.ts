import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { StructuredAgentLaunchResolver } from '../runtime/agent-session/launch/structured-agent-launch-composition'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'
import { ProviderAcquisitionStarts } from '../provider-process/provider-acquisition-starts'
import { providerSpawnedProcessIdentity } from '../provider-process/provider-spawned-process-identity'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError
} from '../native-chat/agent-session-wire/acquisition/structured-agent-session-acquisition-errors'
import {
  AgentSessionPreSpawnError,
  launchPreparationFailure
} from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import {
  agentSessionStartFailure,
  AgentSessionStartEndings
} from '../native-chat/agent-session-wire/startup/structured-agent-session-start-failure'
import { stopAgentSessionProviderRoot } from '../native-chat/agent-session-wire/termination/structured-agent-session-provider-exit-proof'
import type { TraexLaunch } from './traex-launch-resolution'
import type { TraexAppServerConnection } from './traex-app-server-connection'
import { TraexSession, type TraexSessionDeps } from './traex-session'
import { dispatchTraexMessage } from './traex-message-dispatch'
import { TraexRequestError } from './traex-protocol'
import { prepareTraexRewind, recoverTraexRewind, rewindTraexSession } from './traex-rewind'
import { changeTraexThreadGoal } from './traex-thread-goal'
import { cancelTraexTurn } from './traex-turn-cancel'
import { stopTraexBackgroundTasks } from './traex-background-task-stops'

export type TraexSessionAdapterDeps = Omit<TraexSessionDeps, 'onSettled'> & {
  resolveLaunch: StructuredAgentLaunchResolver<TraexLaunch>
  readProcessStartTime?: (pid: number) => Promise<number | null>
  onSettled: (
    sessionId: string,
    clientMessageId: string,
    identity: Parameters<TraexSessionDeps['onSettled']>[1]
  ) => void
  copyConversation?: StructuredAgentSessionAdapter['copyConversation']
  readConversationHistory?: StructuredAgentSessionAdapter['readConversationHistory']
  atRestCommands?: StructuredAgentSessionAdapter['atRestCommands']
  generateText?: StructuredAgentSessionAdapter['generateText']
  stopNaming?: () => void
  closeNaming?: () => Promise<void>
  renameAtRest?: StructuredAgentSessionAdapter['renameProviderSession']
}

export class TraexSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, TraexSession>()
  private readonly acquiring = new Set<string>()
  private readonly starts = new ProviderAcquisitionStarts<TraexAppServerConnection>()
  private readonly endings = new AgentSessionStartEndings()
  private readonly retiring = new Set<Promise<void>>()
  readonly copyConversation: TraexSessionAdapterDeps['copyConversation']
  readonly readConversationHistory: TraexSessionAdapterDeps['readConversationHistory']
  readonly atRestCommands: TraexSessionAdapterDeps['atRestCommands']
  readonly generateText: TraexSessionAdapterDeps['generateText']
  stopProviderNaming = (): void => this.deps.stopNaming?.()

  constructor(private readonly deps: TraexSessionAdapterDeps) {
    this.copyConversation = deps.copyConversation
    this.readConversationHistory = deps.readConversationHistory
    this.atRestCommands = deps.atRestCommands
    this.generateText = deps.generateText
  }

  supportsLocation = supportsSupervisedProviderChildLocation

  acquire: StructuredAgentSessionAdapter['acquire'] = async (input) => {
    const id = input.identity.sessionId
    if (this.acquiring.has(id)) {
      throw new AgentSessionPreSpawnError('TRAE CLI session already has an acquisition')
    }
    this.acquiring.add(id)
    const attempt = this.starts.begin(input.signal)
    let session: TraexSession | undefined
    try {
      if (
        !(await this.starts.stopFailed(id)) ||
        !(await stopAgentSessionProviderRoot(() => this.closeSession(id)))
      ) {
        throw new AgentSessionAcquisitionExitUnprovenError(
          'The previous TRAE CLI writer has not exited'
        )
      }
      this.acknowledgeSessionRelease(id)
      const launch = await waitForPromiseWithSignal(
        this.deps.resolveLaunch({
          identity: input.identity,
          spawnToken: input.spawnToken,
          permissionMode: input.permissionMode
        }),
        attempt.signal
      ).catch((error: unknown) => {
        throw launchPreparationFailure(error)
      })
      attempt.signal.throwIfAborted()
      session = new TraexSession(input, launch, {
        ...this.deps,
        onSettled: (clientId, identity) => this.deps.onSettled(id, clientId, identity)
      })
      this.sessions.set(id, session)
      this.endings.admit(id, session.generation)
      this.starts.track(attempt, session.connection)
      const identity = providerSpawnedProcessIdentity(
        input,
        'TRAE CLI app-server',
        this.deps.readProcessStartTime
      )
      if (session.connection.pid !== undefined) {
        await identity.onSpawned(session.connection.pid)
      }
      const process = await identity.read(session.connection.pid)
      attempt.signal.throwIfAborted()
      if (session.connection.closed) {
        throw session.failure ?? new Error('TRAE CLI exited before initialization')
      }
      return { process, acquisitionGeneration: session.generation }
    } catch (error) {
      if (!session) {
        throw error instanceof AgentSessionAcquisitionExitUnprovenError
          ? error
          : new AgentSessionPreSpawnError(error)
      }
      if (!(await session.close())) {
        this.starts.retainFailed(id, session.connection)
        throw new AgentSessionAcquisitionExitUnprovenError(error)
      }
      throw agentSessionStartFailure(
        error,
        (cause) => (cause instanceof TraexRequestError ? 'final' : undefined),
        session.connection.exited
      )
    } finally {
      this.starts.end(attempt)
      this.acquiring.delete(id)
    }
  }

  open: StructuredAgentSessionAdapter['open'] = async (input) => {
    const session = this.session(input.sessionId, input.fence)
    if (session.generation !== input.acquisitionGeneration) {
      throw new Error('TRAE CLI acquisition changed before initialization')
    }
    try {
      return await session.open(input.signal)
    } catch (error) {
      throw agentSessionStartFailure(
        error,
        (cause) => (cause instanceof TraexRequestError ? 'final' : undefined),
        session.connection.exited && !session.requestedClose
      )
    }
  }

  dispatch: StructuredAgentSessionAdapter['dispatch'] = (input) =>
    dispatchTraexMessage(this.session(input.sessionId, input.fence), input)
  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (input) =>
    this.session(input.sessionId, input.fence)
      .promptOwner(input.itemId)
      .answer(input.itemId, input.response, input.commit)
  dismissPrompt: NonNullable<StructuredAgentSessionAdapter['dismissPrompt']> = (input) =>
    this.session(input.sessionId, input.fence)
      .promptOwner(input.itemId)
      .answer(input.itemId, null, input.commit)
  routePromptCancel = (): { kind: 'dismiss' } => ({ kind: 'dismiss' })
  setOption: StructuredAgentSessionAdapter['setOption'] = (input) =>
    this.session(input.sessionId, input.fence).setOption(input.key, input.value, input.signal)
  readOptions: NonNullable<StructuredAgentSessionAdapter['readOptions']> = async (input) =>
    this.session(input.sessionId, input.fence).readOptions()
  readCommands: NonNullable<StructuredAgentSessionAdapter['readCommands']> = (id) =>
    this.sessions.get(id)?.commands
  changeThreadGoal: NonNullable<StructuredAgentSessionAdapter['changeThreadGoal']> = (input) =>
    changeTraexThreadGoal(this.session(input.sessionId, input.fence), input)

  rewindSupport: NonNullable<StructuredAgentSessionAdapter['rewindSupport']> = (id) => {
    const session = this.sessions.get(id)
    return session?.historyMode === 'legacy' || session?.rewindUnsupported
      ? { supported: false, reason: 'unsupported' }
      : { supported: true }
  }
  prepareRewind: NonNullable<StructuredAgentSessionAdapter['prepareRewind']> = (input) =>
    prepareTraexRewind(this.session(input.sessionId, input.fence), input)
  rewind: NonNullable<StructuredAgentSessionAdapter['rewind']> = (input) =>
    rewindTraexSession(this.session(input.sessionId, input.fence), input)
  recoverRewind: NonNullable<StructuredAgentSessionAdapter['recoverRewind']> = (input) =>
    recoverTraexRewind(this.session(input.sessionId, input.fence), input)

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = (input) =>
    cancelTraexTurn(this.session(input.sessionId, input.fence), input)

  backgroundTaskStops: NonNullable<StructuredAgentSessionAdapter['backgroundTaskStops']> = (id) => {
    const session = this.sessions.get(id)
    return session && !session.ended
      ? {
          supportsTaskStop: true,
          supportsStopAll: session.childWork?.terminalSupport === 'supported'
        }
      : undefined
  }
  stopBackgroundTasks: NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']> = (
    input
  ) => stopTraexBackgroundTasks(this.session(input.sessionId, input.fence), input)

  compact: NonNullable<StructuredAgentSessionAdapter['compact']> = async (input) => {
    const session = this.session(input.sessionId, input.fence)
    session.timeline!.beginCommand(input.command)
    session.compacting = true
    try {
      await session.connection.request('thread/compact/start', {
        threadId: session.threadId,
        ...(input.command.instructions ? { userGuidance: input.command.instructions } : {})
      })
    } catch (error) {
      if (error instanceof TraexRequestError) {
        session.finishCompaction(true)
      }
      throw error
    }
    return { state: 'accepted', providerIdentity: null }
  }

  renameProviderSession: NonNullable<StructuredAgentSessionAdapter['renameProviderSession']> =
    async ({ record, providerSessionId, name }) => {
      const session = this.sessions.get(record.sessionId)
      await (session?.threadId === providerSessionId && !session.connection.closed
        ? session.connection.request('thread/name/set', { threadId: providerSessionId, name })
        : this.deps.renameAtRest?.({ record, providerSessionId, name }))
    }

  heldSends = (id: string): ReadonlySet<string> | undefined => {
    const session = this.sessions.get(id)
    return session ? new Set(session.pending.keys()) : undefined
  }
  holdsDispatch = (id: string): boolean => (this.sessions.get(id)?.pending.size ?? 0) > 0
  holdsLiveProviderProcess = (id: string, generation: string): boolean => {
    const session = this.sessions.get(id)
    return session?.generation === generation && !session.connection.closed
  }
  startupEnding = (id: string, generation: string) => this.endings.get(id, generation)
  retireStartup = (id: string, generation: string) => this.endings.retire(id, generation)

  async closeSession(
    id: string,
    observe?: Parameters<NonNullable<StructuredAgentSessionAdapter['closeSession']>>[1]
  ): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) {
      return this.starts.stopFailed(id)
    }
    const closed = await session.close()
    const result = session.connection.closeResult
    observe?.(
      result
        ? {
            root: result.root,
            workload: result.tree ?? 'unverifiable',
            ...(result.killDelivered ? { deathEvidenceKind: 'kill-delivered' } : {})
          }
        : undefined
    )
    if (closed && result?.tree !== 'exited') {
      throw new AgentSessionAcquisitionRootExitObservedError(
        'TRAE CLI writer stopped without descendant exit proof',
        result?.root === 'exited' ? 'exit-observed' : 'kill-delivered'
      )
    }
    return closed
  }
  disposeSession = this.closeSession
  releaseAcquisition = (input: { sessionId: string }) => this.closeSession(input.sessionId)
  hasOwnedAcquisition = (id: string): boolean =>
    this.sessions.has(id) || this.starts.failedSessionIds().includes(id)
  forceCloseSession = async (id: string): Promise<boolean> => {
    const session = this.sessions.get(id)
    return session ? session.close(false) : true
  }
  acknowledgeSessionRelease(id: string): void {
    const session = this.sessions.get(id)
    if (session?.connection.exited || session?.connection.closeResult?.killDelivered) {
      this.sessions.delete(id)
      const retirement = session.retire()
      this.retiring.add(retirement)
      void retirement.then(() => this.retiring.delete(retirement))
    }
  }
  async closeAll(): Promise<void> {
    this.deps.stopNaming?.()
    await Promise.all(
      [...this.sessions.keys()].map((id) =>
        stopAgentSessionProviderRoot(() => this.closeSession(id))
      )
    )
    await Promise.all(this.starts.failedSessionIds().map((id) => this.starts.stopFailed(id)))
    await this.drainObservedExits()
    await this.atRestCommands?.closeAll?.()
    await this.deps.closeNaming?.()
  }

  async drainObservedExits(): Promise<void> {
    await Promise.all([
      ...this.retiring,
      ...[...this.sessions.values()].map((session) => session.drainObservedExit())
    ])
  }
  private session(id: string, fence: number): TraexSession {
    const session = this.sessions.get(id)
    if (!session || session.input.fence !== fence) {
      throw new Error('No matching TRAE CLI child owns this session')
    }
    return session
  }
}
