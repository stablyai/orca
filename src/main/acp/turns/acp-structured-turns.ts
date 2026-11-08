import type { AcpStructuredTurnsDeps } from './acp-turn-dispatch-contract'
// Steers wait for the active prompt to answer cancellation; agent-initiated turns accept sends directly.

import {
  agentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
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
import type { ContentBlock } from '../generated/acp-protocol.generated'

type Send = { clientMessageId: string; prompt: ContentBlock[]; requestedAt: number }

export class AcpStructuredTurns {
  private active: Send | null = null
  // One cancel per prompt; failed writes allow a later steer to retry.
  private steerCancelled: Send | null = null
  private readonly steers: Send[] = []
  private readonly unsettled = new Set<string>()
  private readonly idleWaiters = new Set<() => void>()
  private ended = false
  private stopAt: number | null = null
  // Steers still preparing their controls; they hold their place like queued steers.
  private preparingSteers = 0
  // Counts Stops: finish() clears stopAt before a preparing steer can see it.
  private withdrawals = 0

  constructor(private readonly deps: AcpStructuredTurnsDeps) {}

  capturePendingSend(clientMessageId: string): () => boolean {
    const send = this.active?.clientMessageId === clientMessageId ? this.active : null
    return () => send !== null && this.active === send && !this.ended
  }

  get running(): boolean {
    return this.active !== null
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
    return this.unsettled
  }

  get holdsSteers(): boolean {
    return this.steers.length > 0 || this.preparingSteers > 0
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
    return this.withdrawSteers()
  }

  /** Earlier admitted steers retain their native queue and settlement while the host holds new input. */
  interruptForPermissionTransition(): void {
    if (this.active) {
      this.cancelForSteer()
    } else if (this.deps.lane.openTurnId !== null) {
      this.deps.withdrawRequests()
      void this.deps.connection.cancel().catch(() => undefined)
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

  dispatch(send: Send): void {
    this.unsettled.add(send.clientMessageId)
    if (this.active) {
      this.steers.push(send)
      this.cancelForSteer()
      return
    }
    this.start(send)
  }

  /** The host owns compaction-message settlement; reuse its open command turn. */
  async compact(command: StructuredAgentSessionCommandRun): Promise<AgentSessionCommandAdmission> {
    if (this.active || this.ended) {
      throw new Error(`${this.deps.agentName} is still working`)
    }
    const { lane } = this.deps
    const send: Send = {
      clientMessageId: command.clientMessageId,
      prompt: acpCompactPrompt(command.instructions),
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
    if (this.unsettled.delete(clientMessageId)) {
      this.deps.settle({
        clientMessageId,
        providerIdentity: { provider: 'orca', clientMessageId }
      })
    }
  }

  private withdrawSteers(): boolean {
    this.withdrawals += 1
    const withdrawn = this.steers.splice(0)
    for (const send of withdrawn) {
      this.reject(
        send.clientMessageId,
        agentSessionFailureFact('cancelled', { neverReachedAgent: true })
      )
    }
    return withdrawn.length > 0
  }

  /** Teardown rejects held steers; an unconfirmed active send remains unknown. */
  end(reason: string, cause?: Error): void {
    this.ended = true
    for (const send of this.steers.splice(0)) {
      this.reject(send.clientMessageId, agentSessionFailureFact('providerExited'))
    }
    const active = this.active
    if (active && cause instanceof AcpAuthRequiredError) {
      this.agentFailed(active, cause)
    } else if (active && this.unsettled.delete(active.clientMessageId)) {
      this.deps.settle({ clientMessageId: active.clientMessageId, state: 'unknown', reason })
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
    if (this.steers.length > 0 || this.preparingSteers > 0) {
      this.cancelForSteer()
    }
    answered.then(
      (result) => {
        if (this.active !== send) {
          return
        }
        lane.apply(lane.translator.promptResult(send.clientMessageId, result, this.deps.now()))
        this.accept(send.clientMessageId)
        this.finish(send)
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
      this.reject(send.clientMessageId, acpPromptRejection(refusal, signedOut, noModel))
    } else {
      lane.apply(lane.translator.promptFailed(send.clientMessageId, error, this.deps.now()))
    }
    const lost = lane.translator.sessionLost(error)
    // Held steers must not reach the dead session.
    this.ended ||= lost
    this.finish(send)
    if (lost) {
      this.deps.sessionLost(error)
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
    const next = this.ended ? undefined : this.steers.shift()
    if (next) {
      this.start(next)
    } else if (!this.active) {
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

  private reject(clientMessageId: string, fact: SubmissionRejectionFact): void {
    if (!this.unsettled.delete(clientMessageId)) {
      return
    }
    this.deps.settle({
      clientMessageId,
      state: 'rejected',
      ...agentSessionFailureWords(fact, { surface: 'rejection', agentName: this.deps.agentName })
    })
  }
}
