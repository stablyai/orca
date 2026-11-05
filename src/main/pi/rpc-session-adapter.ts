import { stopAgentSessionProviderRoot } from '../native-chat/agent-session-wire/structured-agent-session-provider-exit-proof'
import { randomUUID } from 'node:crypto'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import {
  AgentSessionPreSpawnError,
  AgentSessionAcquisitionRootExitObservedError,
  AgentSessionAcquisitionExitUnprovenError,
  launchPreparationFailure,
  type AgentSessionAcquisition,
  type StructuredAgentSessionAcquireInput,
  type StructuredAgentSessionAdapter as SessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { providerSpawnedProcessIdentity } from '../provider-process/provider-spawned-process-identity'
import { ProviderAcquisitionStarts } from '../provider-process/provider-acquisition-starts'
import { piStartExitError } from './rpc-exit-classification'
import { compactPiRpcSession } from './rpc-compaction'
import { buildPiRpcLaunch } from './rpc-launch'
import type { PiRpcResolvedLaunch } from './rpc-launch-resolution'
import { PiRpcSession, type PiRpcConnection } from './rpc-session'
import { dispatchPiRpcMessage } from './rpc-message-dispatch'
import { piAcquireFailure } from './rpc-startup-outcome'
import { openPiStart, watchPiStartExit, piClosedStartError } from './rpc-startup-open'
import { AgentSessionStartEndings } from '../native-chat/agent-session-wire/structured-agent-session-start-failure'
import { applyPiRpcSessionOption } from './rpc-options'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'

import type { PiRpcSessionAdapterDeps } from './rpc-session-adapter-contract'
export type { PiRpcSessionAdapterDeps } from './rpc-session-adapter-contract'

export class PiRpcSessionAdapter implements SessionAdapter {
  private readonly sessions = new Map<string, PiRpcSession>()
  private readonly acquiring = new Set<string>()
  private readonly starts = new ProviderAcquisitionStarts<PiRpcConnection>()
  private readonly retiring = new Set<Promise<void>>()
  private readonly endings = new AgentSessionStartEndings()
  constructor(private readonly deps: PiRpcSessionAdapterDeps) {}

  supportsLocation = supportsSupervisedProviderChildLocation
  supportsCreate: NonNullable<SessionAdapter['supportsCreate']> = (location, agent) =>
    agent === 'pi' && this.supportsLocation(location)

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
      this.acknowledgeSessionRelease(id)
      if (this.sessions.has(id)) {
        throw new AgentSessionPreSpawnError(new Error('Pi session already owns a child'))
      }
      let launch: PiRpcResolvedLaunch
      try {
        launch = await waitForPromiseWithSignal(
          this.deps.resolveLaunch({ identity: input.identity, spawnToken: input.spawnToken }),
          attempt.signal
        )
      } catch (error) {
        // A start withdrawn while resolving is a close, not a failed preparation.
        throw attempt.signal.aborted
          ? new AgentSessionPreSpawnError(error)
          : launchPreparationFailure(error)
      }
      if (attempt.signal.aborted) {
        throw new AgentSessionPreSpawnError(new Error('Pi closed while starting'))
      }
      const spec = buildPiRpcLaunch(launch)
      const fresh = !launch.sessionFile && !launch.forkFile
      session = new PiRpcSession(input, randomUUID(), spec, this.deps, launch, fresh)
      this.sessions.set(id, session)
      watchPiStartExit(session, input, this.endings)
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
      if (session.connection.closed || attempt.signal.aborted) {
        throw piClosedStartError(
          !attempt.signal.aborted && (this.endings.get(id, session.generation) ?? session.failure)
        )
      }
      return {
        process,
        acquisitionGeneration: session.generation
      }
    } catch (error) {
      if (!session) {
        throw error instanceof AgentSessionPreSpawnError ||
          error instanceof AgentSessionAcquisitionExitUnprovenError
          ? error
          : new AgentSessionPreSpawnError(error)
      }
      this.endings.retire(id, session.generation)
      const result = await session.close(false).catch(() => null)
      const exited = piStartExitError(error, session.connection, result)
      if (exited) {
        throw piAcquireFailure(exited)
      }
      this.starts.retainFailed(id, session.connection)
      throw new AgentSessionAcquisitionExitUnprovenError(error)
    } finally {
      this.starts.end(attempt)
      this.acquiring.delete(id)
    }
  }

  open: NonNullable<SessionAdapter['open']> = (input) =>
    openPiStart(this.sessions, this.endings, input)

  dispatch: SessionAdapter['dispatch'] = async (input) => {
    const session = this.session(input.sessionId, input.fence)
    return dispatchPiRpcMessage(
      session,
      input,
      this.deps.logger,
      () => this.sessions.get(input.sessionId) === session
    )
  }

  compact: NonNullable<SessionAdapter['compact']> = async (input) =>
    compactPiRpcSession(this.session(input.sessionId, input.fence), input.command)

  cancelTurn: SessionAdapter['cancelTurn'] = async (input) => {
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
  awaitStoppedRequestEnd: NonNullable<SessionAdapter['awaitStoppedRequestEnd']> = async (
    id,
    at
  ) => {
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
  dismissPrompt: NonNullable<SessionAdapter['dismissPrompt']> = (input) =>
    this.session(input.sessionId, input.fence).dialogs.respond(
      input.itemId,
      null,
      input.commit,
      input.answer
    )
  answerPrompt: SessionAdapter['answerPrompt'] = (input) =>
    this.session(input.sessionId, input.fence).dialogs.respond(
      input.itemId,
      input.response,
      input.commit
    )
  setOption: SessionAdapter['setOption'] = (input) => {
    const session = this.session(input.sessionId, input.fence)
    return applyPiRpcSessionOption(
      session.connection,
      session.selected,
      input.key,
      input.value,
      { signal: input.signal },
      session.optionProof
    )
  }
  readOptions: NonNullable<SessionAdapter['readOptions']> = async (input) =>
    this.session(input.sessionId, input.fence).readOptions()
  readCommands = (id: string) => this.sessions.get(id)?.startup.commands
  /** Pi's /name uses the owned running session; at-rest startup/teardown is not implemented. */
  renameProviderSession: NonNullable<SessionAdapter['renameProviderSession']> = async ({
    record,
    providerSessionId,
    name
  }) => {
    const session = this.sessions.get(record.sessionId)
    if (session?.connection.closed !== false) {
      return
    }
    if (session.openedLink?.handle.nativeId === providerSessionId) {
      await session.connection.request('set_session_name', { name }, { timeoutMs: 5_000 })
    }
  }
  holdsDispatch = (id: string): boolean => this.sessions.get(id)?.turns.holdsDispatch ?? false
  confirmIdle = (id: string) => this.sessions.get(id)?.dialogs.backgroundWork.confirmIdle()
  heldSends = (id: string): ReadonlySet<string> | undefined => this.sessions.get(id)?.heldSends
  startupEnding = (id: string, generation: string) => this.endings.get(id, generation)
  retireStartup = (id: string, generation: string) => this.endings.retire(id, generation)
  holdsLiveProviderProcess(id: string, generation: string): boolean {
    const session = this.sessions.get(id)
    return session?.generation === generation && !session.connection.closed
  }

  closeSession(id: string): Promise<boolean> {
    // A released or closed session's start has no reader left for its ending.
    this.endings.retire(id)
    return this.close(id, true)
  }
  private async close(id: string, requested: boolean): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) {
      return true
    }
    const result = await session.close(requested)
    if (result.root !== 'exited' && !result.killDelivered) {
      return false
    }
    if (result.root !== 'exited' || result.tree !== 'exited') {
      throw new AgentSessionAcquisitionRootExitObservedError(
        new Error('Pi writer stopped without descendant exit proof'),
        result.root === 'exited' ? 'exit-observed' : 'kill-delivered'
      )
    }
    return true
  }
  releaseAcquisition(input: { sessionId: string }): Promise<boolean> {
    return this.closeSession(input.sessionId)
  }
  hasOwnedAcquisition(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }
  forceCloseSession(id: string): Promise<boolean> {
    this.sessions.get(id)?.fail(new Error('Pi event sink failed'))
    return this.close(id, false)
  }
  disposeSession: NonNullable<SessionAdapter['disposeSession']> = this.closeSession
  acknowledgeSessionRelease(id: string): void {
    const session = this.sessions.get(id)
    if (
      !session?.connection.closed ||
      (session.connection.rootVerdict !== 'exited' &&
        !session.connection.lastCloseResult?.killDelivered)
    ) {
      return
    }
    this.sessions.delete(id)
    const retirement = session.retire()
    this.retiring.add(retirement)
    void retirement.then(() => this.retiring.delete(retirement))
  }
  async closeAll(): Promise<void> {
    this.endings.clear()
    await Promise.all(
      [...this.sessions.keys()].map((id) =>
        stopAgentSessionProviderRoot(() => this.closeSession(id))
      )
    )
  }
  async drainObservedExits(): Promise<void> {
    await Promise.all([
      ...this.retiring,
      ...[...this.sessions.values()].map((session) => session.drainObservedExit())
    ])
  }
  private session(id: string, fence: number): PiRpcSession {
    const session = this.sessions.get(id)
    if (
      !session ||
      session.input.fence !== fence ||
      session.connection.closed ||
      !session.openedLink
    ) {
      throw new Error('Pi session is not live under this fence')
    }
    return session
  }
}
