// Steers wait for cancellation or overlap on dialects that yield in place; agent-initiated turns accept sends directly.

import type {
  AgentSessionCommandAdmission,
  StructuredAgentSessionCommandRun
} from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { AcpTurnFlight } from './acp-structured-turn-flight'
import {
  ACP_PROVIDER_EXITED_FACT,
  ACP_WITHDRAWN_STEER_FACT,
  AcpTurnIdleWaiters,
  interruptAcpUnpromptedTurn,
  rejectAcpQueuedSends,
  runAcpCompactTurn,
  settleAcpEndedTurns,
  type AcpTurnSend
} from './acp-structured-turn-settlement'
import type { AcpStructuredTurnsDeps } from './acp-turn-dispatch-contract'

export class AcpStructuredTurns {
  private readonly unsettled = new Set<string>()
  private readonly idle = new AcpTurnIdleWaiters()
  private readonly flight: AcpTurnFlight
  private ended = false
  private stopAt: number | null = null
  private preparingSteers = 0
  private withdrawals = 0

  constructor(private readonly deps: AcpStructuredTurnsDeps) {
    this.flight = new AcpTurnFlight({
      deps,
      unsettled: this.unsettled,
      isEnded: () => this.ended,
      isStopped: () => this.stopAt !== null,
      isPreparingSteers: () => this.preparingSteers > 0,
      markEnded: () => {
        this.ended = true
      },
      clearStop: () => {
        this.stopAt = null
      },
      accept: (clientMessageId) => this.accept(clientMessageId),
      notifyIdle: () => this.idle.notify()
    })
  }

  capturePendingSend(clientMessageId: string): () => boolean {
    const entry =
      this.flight.active?.send.clientMessageId === clientMessageId
        ? this.flight.active
        : this.flight.steering?.send.clientMessageId === clientMessageId
          ? this.flight.steering
          : null
    return () =>
      entry !== null &&
      (this.flight.active === entry || this.flight.steering === entry) &&
      !this.ended
  }

  get running(): boolean {
    return this.flight.running
  }

  /** Interactive requests wait for the person unless Stop or a cancel-steer cuts them short. */
  get acceptsRequests(): boolean {
    return (
      this.stopAt === null &&
      (this.flight.active === null || this.flight.steerCancelled !== this.flight.active.send) &&
      !this.ended
    )
  }

  get heldSends(): ReadonlySet<string> {
    return this.unsettled
  }

  get holdsSteers(): boolean {
    return (
      this.flight.steering !== null || this.flight.steers.length > 0 || this.preparingSteers > 0
    )
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
    const agentTurn = this.running ? null : this.deps.lane.openTurnId
    if ((this.running || agentTurn !== null) && this.stopAt === null) {
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
    const withdrawn = this.flight.steers.splice(0)
    rejectAcpQueuedSends(this.deps, this.unsettled, withdrawn, ACP_WITHDRAWN_STEER_FACT)
    return withdrawn.length > 0
  }

  /** Earlier admitted steers retain their native queue and settlement while the host holds new input. */
  interruptForPermissionTransition(): void {
    if (!this.flight.active) {
      interruptAcpUnpromptedTurn(this.deps)
      return
    }
    this.flight.cancelPromoted ||= this.flight.steering !== null
    this.flight.cancelForSteer()
  }

  whenIdle(signal?: AbortSignal): Promise<void> {
    return this.idle.wait(this.running, signal)
  }

  /** A steer whose controls must run as a prompt first holds its place until released. */
  holdSteer(): () => void {
    this.preparingSteers += 1
    this.flight.cancelForSteer()
    return () => void this.preparingSteers--
  }

  /** A Stop or teardown since `epoch` withdraws a preparing steer like any held steer. */
  withdrawnSince(epoch: number): 'stopped' | 'ended' | null {
    return this.ended ? 'ended' : this.withdrawals === epoch ? null : 'stopped'
  }

  dispatch(send: AcpTurnSend): void {
    this.unsettled.add(send.clientMessageId)
    if (!this.flight.active) {
      this.flight.start(send)
      return
    }
    if (this.flight.canPromptSteer()) {
      this.flight.launchSteer(send)
      return
    }
    this.flight.steers.push(send)
    if (this.deps.dialect?.promptSteers !== true) {
      this.flight.cancelForSteer()
    }
  }

  /** The host owns compaction-message settlement; reuse its open command turn. */
  async compact(command: StructuredAgentSessionCommandRun): Promise<AgentSessionCommandAdmission> {
    await runAcpCompactTurn(
      this.deps,
      command,
      () => this.running || this.ended,
      (send, promptId) => this.flight.startCompact(send, promptId)
    )
    return { state: 'accepted', providerIdentity: null }
  }

  accept(clientMessageId: string): void {
    if (this.unsettled.delete(clientMessageId)) {
      this.deps.settle({ clientMessageId, providerIdentity: { provider: 'orca', clientMessageId } })
    }
  }

  /** Teardown rejects held steers; unconfirmed in-flight sends remain unknown. */
  end(reason: string, cause?: Error): void {
    this.ended = true
    this.flight.cancelPromoted = false
    rejectAcpQueuedSends(
      this.deps,
      this.unsettled,
      this.flight.steers.splice(0),
      ACP_PROVIDER_EXITED_FACT
    )
    const inFlight = { active: this.flight.active, steering: this.flight.steering }
    this.flight.active = null
    this.flight.steering = null
    this.flight.steerCancelled = null
    this.stopAt = null
    settleAcpEndedTurns(this.deps, this.unsettled, inFlight, reason, cause)
    this.idle.notify()
  }
}
