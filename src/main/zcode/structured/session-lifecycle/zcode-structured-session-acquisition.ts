import { ProviderAcquisitionStarts } from '../../../provider-process/provider-acquisition-starts'
import {
  agentSessionAcquireFailure,
  AgentSessionStartEndings,
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
  StructuredAgentSessionAcquireInput
} from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { ZcodeStructuredSession } from './zcode-structured-session'
import {
  startZcodeStructuredSession,
  zcodeStartAnswer,
  zcodeStartFailure
} from './zcode-structured-start'
import {
  acknowledgeZcodeSessionRelease,
  closeAllZcodeSessions,
  closeZcodeSession,
  forceCloseZcodeSession
} from './zcode-structured-session-close'
import { mintZcodeAcquisitionGeneration } from './zcode-structured-session-state'
import type { ZcodeStructuredSessionAdapterDeps } from './zcode-structured-session-state'

// One acquisition per Orca chat: the start attempt registry, the endings a dead child answers
// for, and the retirement handoff a re-acquire waits out.

/** Owns a chat's child lifecycle from acquire through close, over the adapter's session map. */
export class ZcodeAcquisitions {
  private readonly starts = new ProviderAcquisitionStarts<never>()
  private readonly endings = new AgentSessionStartEndings()
  private readonly retiring = new Set<Promise<void>>()
  /** Acquisitions still resolving a launch or spawning; shutdown waits for them. */
  private readonly pendingAcquires = new Set<Promise<unknown>>()
  /**
   * Children whose failed-start cleanup could not prove their exit. Release and shutdown keep
   * reaping them here, since the adapter never published them into the session map.
   */
  private readonly failedStarts = new Map<string, ZcodeStructuredSession>()

  constructor(
    private readonly deps: ZcodeStructuredSessionAdapterDeps,
    private readonly sessions: Map<string, ZcodeStructuredSession>
  ) {}

  acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> {
    const pending = this.acquireNow(input)
    this.pendingAcquires.add(pending)
    void pending
      .catch(() => undefined)
      .then(() => {
        this.pendingAcquires.delete(pending)
      })
    return pending
  }

  /** A start whose cleanup could not prove the child's exit; release and shutdown still reap it. */
  retainFailedStart(sessionId: string, session: ZcodeStructuredSession): void {
    this.failedStarts.set(sessionId, session)
  }

  private async acquireNow(
    input: StructuredAgentSessionAcquireInput
  ): Promise<AgentSessionAcquisition> {
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
      // A retained failed-start child whose exit is still unproven reads as unproven exit —
      // the same verdict as the stop-failed branch — so release keeps its claim on the child.
      if (this.failedStarts.has(sessionId)) {
        throw new AgentSessionAcquisitionExitUnprovenError(
          new Error('the previous zcode start has not exited')
        )
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
        retainFailedStart: (id, child) => this.retainFailedStart(id, child),
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

  startupEnding = (sessionId: string, generation: string): AgentSessionStartFailure | undefined =>
    this.endings.get(sessionId, generation)

  retireStartup = (sessionId: string, generation: string): void => {
    this.endings.retire(sessionId, generation)
  }

  /** The chat's record is going away; a later open answers with no owner. */
  retire = (sessionId: string): void => {
    this.endings.retire(sessionId)
  }

  acknowledgeSessionRelease(sessionId: string): void {
    const retained = this.failedStarts.get(sessionId)
    if (retained !== undefined) {
      // The entry stays until close proves exit: an unproven close must keep the child
      // owned, so a re-acquire refuses instead of starting a second one.
      this.trackRetirement(this.closeRetained(sessionId, retained).then(() => undefined))
      return
    }
    const retirement = acknowledgeZcodeSessionRelease(this.sessions, sessionId)
    this.trackRetirement(retirement)
  }

  /** Closes the retained failed-start child when one exists, else the published session. */
  closeOwned(sessionId: string): Promise<boolean> {
    const retained = this.failedStarts.get(sessionId)
    if (retained !== undefined) {
      return this.closeRetained(sessionId, retained)
    }
    return closeZcodeSession(this.sessions, sessionId)
  }

  forceClose = async (sessionId: string, reason: string): Promise<void> => {
    const retained = this.failedStarts.get(sessionId)
    if (retained !== undefined) {
      // The same settle-first semantics a published session gets, over the retained child.
      retained.failureClose = reason
      retained.markJournalClosed(reason)
      retained.markEnded(Date.now())
      await this.closeRetained(sessionId, retained)
      return
    }
    await forceCloseZcodeSession(this.sessions, sessionId, reason)
  }

  closeAll = async (): Promise<void> => {
    // An acquire still resolving its launch or spawn would register a child after the sweep;
    // shutdown waits for those attempts, then closes everything they may have published.
    await Promise.allSettled(this.pendingAcquires)
    // Deleting the current entry during Map iteration is safe.
    for (const [sessionId, session] of this.failedStarts) {
      await this.closeRetained(sessionId, session)
    }
    await closeAllZcodeSessions(this.sessions, this.endings, (sessionId) =>
      this.closeOwned(sessionId)
    )
  }

  /** Closes a retained child and forgets it only once its exit is proven. */
  private async closeRetained(
    sessionId: string,
    session: ZcodeStructuredSession
  ): Promise<boolean> {
    const stopped = await session.close().catch(() => false)
    if (stopped) {
      this.failedStarts.delete(sessionId)
    }
    return stopped
  }

  private trackRetirement(retirement: Promise<void>): void {
    this.retiring.add(retirement)
    void retirement.then(() => this.retiring.delete(retirement))
  }
}
