// The sends of one ACP session. ACP runs one prompt at a time, so a message sent while Orca's prompt
// runs steers: that prompt is cancelled (the session stays) and the message goes as the next prompt
// once the agent answers the cancel, however long that takes. Each running prompt gets one cancel,
// however many steers arrive; steers wait here, the last one runs, and a Stop withdraws what waits.
// A turn the agent began itself is not Orca's to cut short: a message sent during it goes to the
// agent at once. Each send is settled exactly once:
// accepted when the agent's first event for its turn (or its answer) arrives, rejected when the
// agent refused it or it never left Orca, unknown when the agent died with it or its connection
// broke before it answered.

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
import { AcpAgentError, AcpConnectionClosedError } from './acp-errors'
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
  /** Answers the agent's open requests cancelled, as a steer's cancel ends what they belong to. */
  withdrawRequests: () => void
  lane: AcpStructuredLane
  agentName: string
  now: () => number
  settle: (settlement: AcpDispatchSettlement) => void
}

export class AcpStructuredTurns {
  private active: Send | null = null
  /** The running send a steer already cancelled: one cancel per prompt, retried if its write failed. */
  private steerCancelled: Send | null = null
  /** Steers waiting for the prompt ahead of them to answer its cancel. */
  private readonly steers: Send[] = []
  private readonly unsettled = new Set<string>()
  private readonly idleWaiters = new Set<() => void>()
  private ended = false
  /** When a Stop or a requested close reached this session; it ends with the process. */
  private stopAt: number | null = null

  constructor(private readonly deps: AcpStructuredTurnsDeps) {}

  get running(): boolean {
    return this.active !== null
  }

  /** Whether an agent request may reach the person: Orca's prompt runs and nobody is cutting it
   *  short (no steer's cancel, no Stop). */
  get acceptsRequests(): boolean {
    return (
      this.stopAt === null &&
      this.active !== null &&
      this.steerCancelled !== this.active &&
      !this.ended
    )
  }

  /** Steers wait behind the running prompt's cancel. */
  get holdsSteers(): boolean {
    return this.steers.length > 0
  }

  /** Whether a Stop reached this session. */
  get stopped(): boolean {
    return this.stopAt !== null
  }

  /** When the first Stop reached this session (`Date.now()` time); null before one did. */
  get stoppedAt(): number | null {
    return this.stopAt
  }

  /** A Stop: held steers never reach the agent, and nothing it asks from now on is shown. */
  stop(at: number): boolean {
    this.stopAt ??= at
    return this.withdrawSteers()
  }

  /** Resolves once no prompt of Orca's is running. */
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

  /** The agent took the send: its turn's first event, or its answer, arrived. */
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
      this.reject(send.clientMessageId, agentSessionFailureFact('cancelled'))
    }
    return withdrawn.length > 0
  }

  /** The child is gone: held sends never left Orca, and the running one's fate is unknown. */
  end(reason: string): void {
    this.ended = true
    for (const send of this.steers.splice(0)) {
      this.reject(send.clientMessageId, agentSessionFailureFact('providerExited'))
    }
    const active = this.active
    if (active && this.unsettled.delete(active.clientMessageId)) {
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
    // An agent whose dialect echoes this id on every event of the turn gets it, so its rows join the
    // turn Orca opened; no other agent is sent the extension.
    const meta = lane.translator.injectsPromptIdentity
      ? { promptId: opened.promptId, requestId: opened.promptId }
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
          // A lost connection: the session's end settles the send, as unknown.
          return
        }
        if (!(error instanceof AcpAgentError)) {
          // Answered, but not in a way Orca can read: the turn failed and the next send may go.
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
        const refusal = lane.translator.promptRefused(send.clientMessageId, error)
        if (refusal !== null) {
          // The agent answered the prompt with an error before starting it: its own refusal.
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
    )
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

  /** Asks once per running prompt to end it; never bounded, so a slow answer only delays the steer,
   *  and a Stop still ends the session. */
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
      // Never written: the next steer may ask again.
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
