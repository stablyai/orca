// Steers wait for the active prompt to answer cancellation; agent-initiated turns accept sends directly.

import {
  agentSessionFailureFact,
  providerDiagnostic,
  type SubmissionRejectionFact
} from '../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentJournalDispatchRejection
} from '../../shared/agent-session-failure-words'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import type {
  AgentSessionCommandAdmission,
  StructuredAgentSessionCommandRun
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { ACP_COMPACT_PROMPT } from './acp-compaction-turn'
import { AcpAgentError, AcpAuthRequiredError, AcpConnectionClosedError } from './acp-errors'
import type { AcpStructuredConnection } from './acp-structured-connection'
import type { AcpStructuredLane } from './acp-structured-lane'
import type { ContentBlock } from './generated/acp-protocol.generated'

export type AcpDispatchSettlement = { clientMessageId: string } & (
  | { providerIdentity: AgentJournalItemIdentity }
  | ({ state: 'rejected' } & AgentJournalDispatchRejection)
  | { state: 'unknown'; reason: string }
)

type Send = { clientMessageId: string; prompt: ContentBlock[]; requestedAt: number }

export type AcpStructuredTurnsDeps = {
  connection: Pick<AcpStructuredConnection, 'prompt' | 'cancel'>
  withdrawRequests: () => void
  lane: AcpStructuredLane
  agentName: string
  now: () => number
  settle: (settlement: AcpDispatchSettlement) => void
}

export class AcpStructuredTurns {
  private active: Send | null = null
  // One cancel per prompt; failed writes allow a later steer to retry.
  private steerCancelled: Send | null = null
  private readonly steers: Send[] = []
  private readonly unsettled = new Set<string>()
  private readonly idleWaiters = new Set<() => void>()
  private ended = false
  private stopAt: number | null = null

  constructor(private readonly deps: AcpStructuredTurnsDeps) {}

  get running(): boolean {
    return this.active !== null
  }

  /** Interactive requests require an active Orca prompt with no Stop or steer cancellation. */
  get acceptsRequests(): boolean {
    return (
      this.stopAt === null &&
      this.active !== null &&
      this.steerCancelled !== this.active &&
      !this.ended
    )
  }

  get heldSends(): ReadonlySet<string> {
    return this.unsettled
  }

  get holdsSteers(): boolean {
    return this.steers.length > 0
  }

  get stopped(): boolean {
    return this.stopAt !== null
  }

  /** First Stop time on the Date.now clock. */
  get stoppedAt(): number | null {
    return this.stopAt
  }

  stop(at: number): boolean {
    this.stopAt ??= at
    return this.withdrawSteers()
  }

  whenIdle(): Promise<void> {
    if (!this.active) {
      return Promise.resolve()
    }
    return new Promise((resolve) => this.idleWaiters.add(resolve))
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
      prompt: [...ACP_COMPACT_PROMPT],
      requestedAt: this.deps.now()
    }
    lane.beginCommand(command)
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
    if (this.steers.length > 0) {
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
    if (refusal !== null) {
      const detail = providerDiagnostic(refusal, 'person')
      this.reject(
        send.clientMessageId,
        agentSessionFailureFact(
          lane.translator.authenticationRequired(error) ? 'notSignedIn' : 'providerRejected',
          detail ? { detail } : {}
        )
      )
    } else {
      lane.apply(lane.translator.promptFailed(send.clientMessageId, error, this.deps.now()))
    }
    this.finish(send)
  }

  private finish(send: Send): void {
    if (this.active === send) {
      this.active = null
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
