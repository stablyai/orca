// Steers wait for cancellation, inject via extension, or overlap on dialects that yield in place.

import type {
  AgentSessionCommandAdmission,
  StructuredAgentSessionCommandRun
} from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { PromptResponse } from '../generated/acp-protocol.generated'
import type { AcpPromptOpening } from '../timeline/acp-prompt-turns'
import { AcpPendingSteers } from './acp-pending-steers'
import { AcpTurnFlight } from './acp-structured-turn-flight'
import {
  interruptAcpUnpromptedTurn,
  runAcpCompactTurn,
  settleAcpEndedTurns
} from './acp-structured-turn-settlement'
import type {
  AcpSteerMode,
  AcpStructuredTurnsDeps,
  AcpTurnSend as Send
} from './acp-turn-dispatch-contract'
import { AcpTurnIdleWaiters } from './acp-turn-idle-waiters'

export class AcpStructuredTurns {
  private readonly steers: AcpPendingSteers
  private readonly flight: AcpTurnFlight
  /** Mail joins a running prompt via steering extension or concurrent prompt instead of cancelling. */
  readonly steersMail: boolean
  private readonly idleWaiters = new AcpTurnIdleWaiters()
  private ended = false
  private stopAt: number | null = null
  private preparingSteers = 0
  private withdrawals = 0

  constructor(private readonly deps: AcpStructuredTurnsDeps) {
    this.steersMail = deps.steeringSessionId !== undefined || deps.dialect?.promptSteers === true
    const joinableTurn = () =>
      this.flight.active && this.acceptsRequests
        ? deps.lane.promptTurnIdentity(this.flight.active.send.clientMessageId)
        : null
    this.steers = new AcpPendingSteers(deps, {
      // A preparing steer's model command owns the prompt slot, so nothing may start under it.
      busy: () => this.running || this.preparingSteers > 0,
      joinableTurn,
      start: (send) => this.flight.start(send),
      cancel: () => this.flight.cancelForSteer(),
      canPromptSteer: () => this.flight.canPromptSteer(),
      launchPromptSteer: (send) => this.flight.launchSteer(send),
      onSettled: () => this.notifyIdle()
    })
    this.flight = new AcpTurnFlight({
      deps,
      sink: this.steers,
      isEnded: () => this.ended,
      isStopped: () => this.stopAt !== null,
      isPreparingSteers: () => this.preparingSteers > 0,
      markEnded: () => {
        this.ended = true
      },
      clearStop: () => {
        this.stopAt = null
      },
      advanceSteers: () => this.steers.advance(),
      notifyIdle: () => this.notifyIdle()
    })
    if (deps.steeringSessionId !== undefined) {
      deps.lane.onTurnOpened(() => {
        if (this.steers.held && joinableTurn()) {
          this.steers.advance()
        }
      })
    }
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
    return this.steers.unsettled
  }

  get holdsSteers(): boolean {
    return this.flight.steering !== null || this.steers.held || this.preparingSteers > 0
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
    const withdrawn = this.steers.stop()
    this.notifyIdle()
    return withdrawn
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

  whenIdle(signal?: AbortSignal, scope: 'all' | 'prompt' = 'all'): Promise<void> {
    const promptOnly = scope === 'prompt'
    const idle = () => this.ended || (!this.running && (promptOnly || !this.holdsSteers))
    return signal?.aborted || idle() ? Promise.resolve() : this.idleWaiters.wait(idle, signal)
  }

  /** A steer whose controls must run as a prompt first holds its place until released. */
  holdSteer(): () => void {
    this.preparingSteers += 1
    this.flight.cancelPromoted ||= this.flight.steering !== null
    this.flight.cancelForSteer()
    return () => {
      this.preparingSteers -= 1
      this.steers.advance()
      this.notifyIdle()
    }
  }

  /** A Stop or teardown since `epoch` withdraws a preparing steer like any held steer. */
  withdrawnSince(epoch: number): 'stopped' | 'ended' | null {
    return this.ended ? 'ended' : this.withdrawals === epoch ? null : 'stopped'
  }

  dispatch(send: Send, mode: AcpSteerMode): void {
    this.steers.unsettled.add(send.clientMessageId)
    if (!this.running && !this.steers.held && this.preparingSteers === 0) {
      this.flight.start(send)
      return
    }
    this.steers.submit(send, mode)
  }

  /** The host owns compaction-message settlement; reuse its open command turn. */
  async compact(command: StructuredAgentSessionCommandRun): Promise<AgentSessionCommandAdmission> {
    await runAcpCompactTurn(
      this.deps,
      command,
      () => this.running || this.steers.held || this.ended,
      (send, promptId) => this.flight.startCompact(send, promptId)
    )
    return { state: 'accepted', providerIdentity: null }
  }

  accept(clientMessageId: string): void {
    this.steers.accept(clientMessageId)
  }

  /** Teardown rejects held steers; unconfirmed in-flight sends remain unknown. */
  end(reason: string, cause?: Error): void {
    this.ended = true
    this.flight.cancelPromoted = false
    this.steers.end(reason)
    const inFlight = { active: this.flight.active, steering: this.flight.steering }
    this.flight.active = null
    this.flight.steering = null
    this.flight.steerCancelled = null
    this.stopAt = null
    settleAcpEndedTurns(this.deps, this.steers, inFlight, reason, cause)
    this.notifyIdle()
  }

  /** An earlier app's prompt to a kept agent: its answer ends the open turn; its send settles here. */
  adoptEarlier(id: string, answered: () => Promise<PromptResponse>, ...opening: AcpPromptOpening) {
    if (!this.running && !this.ended) {
      this.steers.unsettled.add(id)
      this.flight.adoptEarlier(id, answered, ...opening)
    }
  }

  private notifyIdle(): void {
    this.idleWaiters.wake()
  }
}
