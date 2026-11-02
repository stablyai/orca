import { preparePiRpcPrompt } from './rpc-prompt'
import { readyConstruction } from '../native-chat/agent-session-wire/structured-agent-session-construction'
import { acquirePiRpcSession } from './rpc-session-acquisition'
import { stopAgentSessionProviderRoot } from '../native-chat/agent-session-wire/structured-agent-session-provider-exit-proof'
import {
  AgentSessionAcquisitionRootExitObservedError,
  type StructuredAgentSessionAcquireInput,
  type StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { ProviderAcquisitionStarts } from '../provider-process/provider-acquisition-starts'
import { compactPiRpcSession } from './rpc-compaction'
import type { PiRpcResolvedLaunch } from './rpc-launch-resolution'
import type { PiRpcSession, PiRpcSessionDeps, PiRpcConnection } from './rpc-session'
import { dispatchPiRpcMessage } from './rpc-message-dispatch'
import { applyPiRpcSessionOption } from './rpc-options'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'

export type PiRpcSessionAdapterDeps = PiRpcSessionDeps & {
  resolveLaunch: (
    input: Pick<
      StructuredAgentSessionAcquireInput,
      'identity' | 'spawnToken' | 'constructionIntent'
    >
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

  acquire = (input: StructuredAgentSessionAcquireInput) =>
    acquirePiRpcSession(input, {
      deps: this.deps,
      sessions: this.sessions,
      starts: this.starts,
      acquiring: this.acquiring,
      acknowledgeSessionRelease: (id) => this.acknowledgeSessionRelease(id)
    })

  open = async (input: Parameters<StructuredAgentSessionAdapter['open']>[0]) => {
    const session = this.sessions.get(input.sessionId)
    if (
      !session ||
      session.input.fence !== input.fence ||
      session.generation !== input.acquisitionGeneration ||
      session.connection.closed
    ) {
      throw new Error('Pi child changed before it opened')
    }
    return readyConstruction(await session.open(input.signal))
  }

  historicalInputBytes: NonNullable<StructuredAgentSessionAdapter['historicalInputBytes']> = async (
    input
  ) => ({
    bytes: Buffer.byteLength(JSON.stringify(await preparePiRpcPrompt(input.body))),
    limit: 8 * 1024 * 1024
  })

  dispatch: StructuredAgentSessionAdapter['dispatch'] = async (input) => {
    const session = this.session(input.sessionId, input.fence)
    return dispatchPiRpcMessage(
      session,
      input,
      this.deps.logger,
      () => this.sessions.get(input.sessionId) === session
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
    return applyPiRpcSessionOption(
      session.connection,
      session.selected,
      input.key,
      input.value,
      { signal: input.signal },
      session.optionProof
    )
  }
  readOptions: NonNullable<StructuredAgentSessionAdapter['readOptions']> = async (input) =>
    this.session(input.sessionId, input.fence).readOptions()
  readCommands = (id: string) => this.sessions.get(id)?.startup.commands
  /** Pi's /name uses the owned running session; at-rest startup/teardown is not implemented. */
  renameProviderSession: NonNullable<StructuredAgentSessionAdapter['renameProviderSession']> =
    async ({ record, providerSessionId, name }) => {
      const session = this.sessions.get(record.sessionId)
      if (session?.connection.closed !== false) {
        return
      }
      if (session.openedLink?.handle.nativeId === providerSessionId) {
        await session.connection.request('set_session_name', { name }, { timeoutMs: 5_000 })
      }
    }
  holdsDispatch = (id: string): boolean => this.sessions.get(id)?.turns.holdsDispatch ?? false
  heldSends = (id: string): ReadonlySet<string> | undefined => this.sessions.get(id)?.heldSends
  holdsLiveProviderProcess(id: string, generation: string): boolean {
    const session = this.sessions.get(id)
    return session?.generation === generation && !session.connection.closed
  }

  closeSession(id: string): Promise<boolean> {
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
  disposeSession: NonNullable<StructuredAgentSessionAdapter['disposeSession']> = this.closeSession
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
