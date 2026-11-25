import type { AcpStructuredTurnsDeps, AcpTurnSend as Send } from './acp-turn-dispatch-contract'
import { AcpPendingSteers } from './acp-pending-steers'
import type {
  AgentSessionCommandAdmission,
  StructuredAgentSessionCommandRun
} from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { acpCompactPrompt } from './acp-compaction-turn'
import {
  AcpAgentError,
  AcpAuthRequiredError,
  AcpConnectionClosedError
} from '../transport/acp-errors'
import { acpPromptRejection } from './acp-prompt-failure'
import { acpPromptTurnId } from '../timeline/acp-prompt-turns'
import { spellProviderTimelineKey } from '../../native-chat/agent-session-timeline/provider-timeline-identity'

export class AcpStructuredTurns {
  private active: Send | null = null
  // One cancel per prompt; failed writes allow a later steer to retry.
  private steerCancelled: Send | null = null
  private readonly steers: AcpPendingSteers
  private readonly idleWaiters = new Set<() => void>()
  private ended = false
  private stopAt: number | null = null
  // Steers still preparing their controls; they hold their place like queued steers.
  private preparingSteers = 0
  // Counts Stops: finish() clears stopAt before a preparing steer can see it.
  private withdrawals = 0

  constructor(private readonly deps: AcpStructuredTurnsDeps) {
    this.steers = new AcpPendingSteers(deps, {
      running: () => this.running,
      joinableTurn: () => {
        if (!this.active || !this.acceptsRequests || deps.steeringSessionId === undefined) {
          return null
        }
        const turnId = spellProviderTimelineKey(deps.steeringSessionId, {
          source: 'provider',
          value: acpPromptTurnId(this.active.clientMessageId)
        })
        return deps.lane.openTurnId === turnId ? deps.lane.openTurnIdentity : null
      },
      start: (send) => this.start(send),
      cancel: () => this.cancelForSteer()
    })
  }

  capturePendingSend(clientMessageId: string): () => boolean {
    const send = this.active?.clientMessageId === clientMessageId ? this.active : null
    return () => send !== null && this.active === send && !this.ended
  }

  get running(): boolean {
    return this.active !== null
  }

  get canInjectSteering(): boolean {
    return this.active !== null && this.deps.steeringSessionId !== undefined
  }

  /** Interactive requests wait for the person, including in turns the agent began itself, unless Stop or a steer cuts them short. */
  get acceptsRequests(): boolean {
    return (
      this.stopAt === null &&
      (this.active === null || this.steerCancelled !== this.active) &&
      !this.ended
    )
  }

  get heldSends(): ReadonlySet<string> {
    return this.steers.unsettled
  }

  get holdsSteers(): boolean {
    return this.steers.held || this.preparingSteers > 0
  }

  get withdrawalEpoch(): number {
    return this.withdrawals
  }

  get stopped(): boolean {
    return this.stopAt !== null
  }

  /** First Stop time on the Date.now clock. */
  get stoppedAt(): number | null {
    return this.stopAt
  }

  /** A Stop covers the running prompt or the agent's own open turn; later work may ask again. */
  stop(at: number): boolean {
    const agentTurn = this.active ? null : this.deps.lane.openTurnId
    if ((this.active || agentTurn !== null) && this.stopAt === null) {
      this.stopAt = at
      if (agentTurn !== null) {
        void this.deps.lane.whenTurnLeaves(agentTurn).then(() => {
          if (this.stopAt === at) {
            this.stopAt = null
          }
        })
      }
    }
    this.withdrawals += 1
    return this.steers.stop()
  }

  /** Earlier admitted steers retain their native queue and settlement while the host holds new input. */
  interruptForPermissionTransition(): void {
    if (this.active) {
      this.cancelForSteer()
    } else if (this.deps.lane.openTurnId !== null && !this.deps.lane.agentTurn.endUnasked()) {
      this.deps.withdrawRequests()
      void this.deps.connection.cancel().catch(() => undefined)
      this.deps.lane.agentTurn.end('cancelled')
    }
  }

  whenIdle(signal?: AbortSignal): Promise<void> {
    if (!this.active || signal?.aborted) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const wake = (): void => {
        this.idleWaiters.delete(wake)
        signal?.removeEventListener('abort', wake)
        resolve()
      }
      this.idleWaiters.add(wake)
      signal?.addEventListener('abort', wake, { once: true })
    })
  }

  /** A steer whose controls must run as a prompt first holds its place until released: Stop
   *  reaches it, and answers ahead of it are cancelled as they start, as for any newer steer. */
  holdSteer(): () => void {
    this.preparingSteers += 1
    this.cancelForSteer()
    return () => void this.preparingSteers--
  }

  /** A Stop or teardown since `epoch` withdraws a preparing steer like any held steer. */
  withdrawnSince(epoch: number): 'stopped' | 'ended' | null {
    return this.ended ? 'ended' : this.withdrawals === epoch ? null : 'stopped'
  }

  dispatch(send: Send, inject: boolean): void {
    this.steers.unsettled.add(send.clientMessageId)
    if (!this.active && !this.steers.held) {
      this.start(send)
      return
    }
    this.steers.submit(send, inject)
  }

  /** The host owns compaction-message settlement; reuse its open command turn. */
  async compact(command: StructuredAgentSessionCommandRun): Promise<AgentSessionCommandAdmission> {
    if (this.active || this.steers.held || this.ended) {
      throw new Error(`${this.deps.agentName} is still working`)
    }
    const { lane } = this.deps
    const agentTurn = lane.openTurnId
    // A backed-up journal admits the agent turn's end later; adopt the command after it.
    if (lane.agentTurn.end() && agentTurn !== null) {
      await lane.whenTurnLeaves(agentTurn)
      if (this.active || this.steers.held || this.ended) {
        throw new Error(`${this.deps.agentName} is still working`)
      }
    }
    const send: Send = {
      clientMessageId: command.clientMessageId,
      prompt: acpCompactPrompt(command.instructions, this.deps.compactCommand),
      requestedAt: this.deps.now()
    }
    lane.beginCommand(command)
    this.stopAt = null
    try {
      const opened = lane.translator.openPrompt(
        send.clientMessageId,
        send.requestedAt,
        command.turnId
      )
      this.active = send
      this.run(send, opened.promptId)
    } catch (error) {
      lane.forgetCommand(command.turnId)
      throw error
    }
    return { state: 'accepted', providerIdentity: null }
  }

  accept(clientMessageId: string): void {
    this.steers.accept(clientMessageId)
  }

  /** Teardown rejects held steers; an unconfirmed active send remains unknown. */
  end(reason: string, cause?: Error): void {
    this.ended = true
    this.steers.end(reason)
    const active = this.active
    if (active && cause instanceof AcpAuthRequiredError) {
      this.agentFailed(active, cause)
    } else if (active) {
      this.steers.unknown(active.clientMessageId, reason)
    }
    this.active = null
    this.steerCancelled = null
    this.notifyIdle()
  }

  private start(send: Send): void {
    const { lane } = this.deps
    // A new message is not covered by a Stop of the agent's own earlier turn.
    this.stopAt = null
    this.active = send
    lane.agentTurn.end()
    const opened = lane.translator.openPrompt(send.clientMessageId, send.requestedAt)
    lane.apply(opened.events)
    this.run(send, opened.promptId)
  }

  private run(send: Send, promptId: string): void {
    const { lane } = this.deps
    // Inject identity only for dialects that echo it on turn events.
    const meta = lane.translator.injectsPromptIdentity
      ? { promptId, requestId: promptId }
      : undefined
    const answered = this.deps.connection.prompt(send.prompt, meta)
    if (this.preparingSteers > 0) {
      this.cancelForSteer()
    } else {
      this.steers.advance()
    }
    answered.then(
      (result) => {
        if (this.active !== send) {
          return
        }
        const cancelled = this.stopAt !== null || this.steerCancelled === send
        const { clientMessageId } = send
        lane.apply(
          lane.translator.promptResult(clientMessageId, result, this.deps.now(), cancelled)
        )
        this.accept(send.clientMessageId)
        this.finishAndRetireIfLost(send, lane.translator.failures.takeSessionLoss())
      },
      (error: unknown) => {
        if (this.active !== send || error instanceof AcpConnectionClosedError) {
          // Connection teardown owns unknown-send settlement.
          return
        }
        if (!(error instanceof AcpAgentError)) {
          // Unreadable replies fail the turn but allow the next send.
          lane.apply(
            lane.translator.promptFailed(
              send.clientMessageId,
              error instanceof Error ? error : new Error(String(error)),
              this.deps.now()
            )
          )
          this.accept(send.clientMessageId)
          this.finish(send)
          return
        }
        this.agentFailed(send, error)
      }
    )
  }

  private agentFailed(send: Send, error: AcpAgentError): void {
    const { lane } = this.deps
    const refusal = lane.translator.promptRefused(send.clientMessageId, error)
    // Also retires the proof of a model the agent turned out not to have.
    const noModel = this.deps.modelRefusal?.(error)
    if (refusal !== null) {
      const signedOut = lane.translator.authenticationRequired(error)
      this.steers.reject(send.clientMessageId, acpPromptRejection(refusal, signedOut, noModel))
    } else {
      lane.apply(lane.translator.promptFailed(send.clientMessageId, error, this.deps.now()))
    }
    this.finishAndRetireIfLost(send, lane.translator.sessionLost(error) ? error : undefined)
  }

  private finishAndRetireIfLost(send: Send, sessionLoss: Error | undefined): void {
    // Held steers must not reach the dead session.
    this.ended ||= sessionLoss !== undefined
    this.finish(send)
    if (sessionLoss) {
      this.deps.sessionLost(sessionLoss)
    }
  }

  private finish(send: Send): void {
    if (this.active === send) {
      this.active = null
      this.stopAt = null
    }
    if (this.steerCancelled === send) {
      this.steerCancelled = null
    }
    if (!this.ended) {
      this.steers.advance()
    }
    if (!this.active) {
      this.notifyIdle()
    }
  }

  /** Steering waits indefinitely for cancellation; Stop can still end the child. */
  private cancelForSteer(): void {
    const send = this.active
    if (!send) {
      return
    }
    this.deps.withdrawRequests()
    if (this.steerCancelled === send) {
      return
    }
    this.steerCancelled = send
    this.deps.connection.cancel().catch(() => {
      // A failed write lets the next steer retry.
      if (this.steerCancelled === send) {
        this.steerCancelled = null
      }
    })
  }

  private notifyIdle(): void {
    for (const wake of this.idleWaiters) {
      wake()
    }
    this.idleWaiters.clear()
  }
}
