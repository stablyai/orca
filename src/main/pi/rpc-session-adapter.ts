import { randomUUID } from 'node:crypto'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { AgentSessionUnavailable } from '../../shared/agent-session-availability'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import {
  AgentSessionPreSpawnError,
  AgentSessionAcquisitionRootExitObservedError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionExitProvenError,
  type AgentSessionAcquisition,
  type StructuredAgentSessionAcquireInput,
  type StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { providerSpawnedProcessIdentity } from '../provider-process/provider-spawned-process-identity'
import { ProviderAcquisitionStarts } from '../provider-process/provider-acquisition-starts'
import { compactPiRpcSession } from './rpc-compaction'
import { buildPiRpcLaunch } from './rpc-launch'
import { piRpcProviderLink, type PiRpcResolvedLaunch } from './rpc-launch-resolution'
import { PiRpcSession, type PiRpcSessionDeps, type PiRpcConnection } from './rpc-session'
import { PiRpcPromptError, preparePiRpcPrompt } from './rpc-prompt'
import { applyPiRpcSessionOption, readPiRpcSessionOptions } from './rpc-options'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'
import { ClaudeDispatchContentError } from '../claude/claude-structured-dispatch-content'

export type PiRpcSessionAdapterDeps = PiRpcSessionDeps & {
  resolveLaunch: (
    identity: StructuredAgentSessionAcquireInput['identity']
  ) => Promise<PiRpcResolvedLaunch>
  readProcessStartTime?: (pid: number) => Promise<number | null>
}

export class PiRpcSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, PiRpcSession>()
  private readonly acquiring = new Set<string>()
  private readonly starts = new ProviderAcquisitionStarts<PiRpcConnection>()
  private readonly retiring = new Set<Promise<void>>()
  constructor(private readonly deps: PiRpcSessionAdapterDeps) {}

  supportsLocation = supportsSupervisedProviderChildLocation
  supportsCreate: NonNullable<StructuredAgentSessionAdapter['supportsCreate']> = (
    location,
    agent
  ) => agent === 'pi' && this.supportsLocation(location)

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> {
    const id = input.identity.sessionId
    if (this.acquiring.has(id)) {
      throw new AgentSessionPreSpawnError(new Error('Pi session already owns a child'))
    }
    this.acquiring.add(id)
    const attempt = this.starts.begin(input.signal)
    let session: PiRpcSession | undefined
    try {
      if (attempt.signal.aborted) {
        throw new AgentSessionPreSpawnError(new Error('Pi closed while starting'))
      }
      if (!(await this.starts.stopFailed(id))) {
        throw new AgentSessionAcquisitionExitUnprovenError(
          new Error('Previous Pi start has not exited')
        )
      }
      const previous = this.sessions.get(id)
      if (previous?.connection.closed && previous.connection.rootVerdict === 'exited') {
        this.acknowledgeSessionRelease(id)
      } else if (previous) {
        throw new AgentSessionPreSpawnError(new Error('Pi session already owns a child'))
      }
      let launch: PiRpcResolvedLaunch
      try {
        launch = await waitForPromiseWithSignal(
          this.deps.resolveLaunch(input.identity),
          attempt.signal
        )
      } catch (error) {
        throw new AgentSessionPreSpawnError(error)
      }
      if (attempt.signal.aborted) {
        throw new AgentSessionPreSpawnError(new Error('Pi closed while starting'))
      }
      const spec = buildPiRpcLaunch({
        ...launch,
        structuredSession: { id, spawnToken: input.spawnToken }
      })
      session = new PiRpcSession(input, randomUUID(), spec, this.deps)
      this.sessions.set(id, session)
      this.starts.track(attempt, session.connection)
      const spawned = providerSpawnedProcessIdentity(
        input,
        'Pi RPC',
        this.deps.readProcessStartTime
      )
      if (session.connection.pid !== undefined) {
        await spawned.onSpawned(session.connection.pid)
      }
      const process = await spawned.read(session.connection.pid)
      const file = await waitForPromiseWithSignal(session.start(), attempt.signal)
      if (session.connection.closed || attempt.signal.aborted) {
        throw new Error('Pi exited while starting')
      }
      return {
        process,
        acquisitionGeneration: session.generation,
        link: piRpcProviderLink(launch, file, input.fence, randomUUID(), Date.now())
      }
    } catch (error) {
      if (!session) {
        throw error instanceof AgentSessionPreSpawnError ||
          error instanceof AgentSessionAcquisitionExitUnprovenError
          ? error
          : new AgentSessionPreSpawnError(error)
      }
      const result = await session.close(false).catch(() => null)
      if (result?.root === 'exited') {
        if (session.connection.processless) {
          throw new AgentSessionAcquisitionExitProvenError(error)
        }
        throw new AgentSessionAcquisitionRootExitObservedError(error)
      }
      this.starts.retainFailed(id, session.connection)
      throw new AgentSessionAcquisitionExitUnprovenError(error)
    } finally {
      this.starts.end(attempt)
      this.acquiring.delete(id)
    }
  }

  dispatch: StructuredAgentSessionAdapter['dispatch'] = async (input) => {
    const session = this.session(input.sessionId, input.fence)
    let prompt
    try {
      prompt = await preparePiRpcPrompt(input.body)
    } catch (error) {
      this.deps.logger.warn('Pi prompt could not be prepared', {
        scope: 'pi-prompt',
        sessionId: input.sessionId,
        error
      })
      return {
        state: 'rejected',
        ...agentSessionFailureWords(
          error instanceof PiRpcPromptError || error instanceof ClaudeDispatchContentError
            ? error.failure
            : agentSessionFailureFact('attachmentUnreadable'),
          { agentName: 'Pi', surface: 'rejection' }
        )
      }
    }
    return session.turns.submit(
      input.clientMessageId,
      input.requestedAt ?? Date.now(),
      { ...prompt },
      input.beforeDispatch
    )
  }

  compact: NonNullable<StructuredAgentSessionAdapter['compact']> = async (input) =>
    compactPiRpcSession(this.session(input.sessionId, input.fence), input.command)

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = async (input) => {
    const session = this.session(input.sessionId, input.fence)
    const turnId = input.resolveLiveTurnId ? input.resolveLiveTurnId() : session.lane.openTurnId
    if (input.turnId !== undefined && input.turnId !== turnId) {
      return { cancelled: false }
    }
    if (!turnId && !session.turns.holdsDispatch) {
      return { cancelled: false }
    }
    session.turns.stop()
    session.dialogs.cancelAll()
    await session.connection.request('abort', {}, { timeoutMs: 2_000 })
    return { cancelled: true, ...(turnId ? { turnId } : {}) }
  }
  stopEndsSession(): boolean {
    return true
  }
  awaitStoppedRequestEnd: NonNullable<StructuredAgentSessionAdapter['awaitStoppedRequestEnd']> =
    async (id, at) => {
      const session = this.sessions.get(id)
      const turn = session?.lane.openTurnId
      if (!session) {
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        if (turn) {
          await Promise.race([
            session.lane.whenTurnLeaves(turn),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, Math.max(0, at + 2_000 - Date.now()))
              timer.unref()
            })
          ])
        }
      } finally {
        clearTimeout(timer)
      }
      try {
        await session.connection.request('get_state', {}, { timeoutMs: 1_000 })
      } catch (error) {
        this.deps.logger.warn('Pi checkpoint could not be read before stopping', {
          scope: 'pi-stop-checkpoint',
          sessionId: id,
          error
        })
      }
    }
  routePromptCancel(): { kind: 'dismiss' } {
    return { kind: 'dismiss' }
  }
  dismissPrompt: NonNullable<StructuredAgentSessionAdapter['dismissPrompt']> = (input) =>
    this.session(input.sessionId, input.fence).dialogs.respond(
      input.itemId,
      null,
      input.commit,
      input.answer
    )
  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (input) =>
    this.session(input.sessionId, input.fence).dialogs.respond(
      input.itemId,
      input.response,
      input.commit
    )
  setOption: StructuredAgentSessionAdapter['setOption'] = (input) => {
    const session = this.session(input.sessionId, input.fence)
    return applyPiRpcSessionOption(session.connection, session.selected, input.key, input.value)
  }
  readOptions: NonNullable<StructuredAgentSessionAdapter['readOptions']> = (input) =>
    readPiRpcSessionOptions(this.session(input.sessionId, input.fence).connection)
  readCommands = (id: string) => this.sessions.get(id)?.commands
  readOptionRestoreFailures(id: string): readonly string[] {
    return this.sessions.get(id)?.skipped ?? []
  }
  holdsDispatch(id: string): boolean {
    return this.sessions.get(id)?.turns.holdsDispatch ?? false
  }
  /** Started with no model listed: Pi keeps a placeholder, so every prompt this child takes fails
   *  as not signed in, even after a sign-in, which only a new Pi reads. */
  startUnavailable(id: string): AgentSessionUnavailable | undefined {
    const session = this.sessions.get(id)
    return session &&
      !session.connection.closed &&
      session.connection.rootVerdict !== 'exited' &&
      session.options?.models.length === 0
      ? { reason: 'notSignedIn' }
      : undefined
  }

  async closeSession(id: string, requested = true): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) {
      return true
    }
    const result = await session.close(requested)
    if (result.root !== 'exited') {
      return false
    }
    if (result.tree !== 'exited') {
      throw new AgentSessionAcquisitionRootExitObservedError(new Error('Pi root exit observed'))
    }
    return true
  }
  releaseAcquisition(input: { sessionId: string }): Promise<boolean> {
    return this.closeSession(input.sessionId)
  }
  forceCloseSession(id: string): Promise<boolean> {
    this.sessions.get(id)?.fail(new Error('Pi event sink failed'))
    return this.closeSession(id, false)
  }
  disposeSession(id: string): Promise<boolean> {
    return this.closeSession(id)
  }
  acknowledgeSessionRelease(id: string): void {
    const session = this.sessions.get(id)
    if (!session?.connection.closed || session.connection.rootVerdict !== 'exited') {
      return
    }
    this.sessions.delete(id)
    const retirement = session.retire()
    this.retiring.add(retirement)
    void retirement.then(() => this.retiring.delete(retirement))
  }
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id)))
  }
  async drainObservedExits(): Promise<void> {
    await Promise.all([
      ...this.retiring,
      ...[...this.sessions.values()].map((session) => session.drainObservedExit())
    ])
  }
  private session(id: string, fence: number): PiRpcSession {
    const session = this.sessions.get(id)
    if (!session || session.input.fence !== fence || session.connection.closed) {
      throw new Error('Pi session is not live under this fence')
    }
    return session
  }
}
