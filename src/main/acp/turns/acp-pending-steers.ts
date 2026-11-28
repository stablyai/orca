import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import {
  agentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { AcpAgentError } from '../transport/acp-errors'
import type {
  AcpSteerMode,
  AcpStructuredTurnsDeps,
  AcpTurnSend
} from './acp-turn-dispatch-contract'

type Steer = { send: AcpTurnSend; mode: AcpSteerMode | 'wait' }
const steeringReply = lazyZodSchema(() =>
  z.looseObject({ outcome: z.enum(['injected', 'promptRequired', 'failed']) })
)

/** The provider keeps custody from admission through injection or the next prompt. */
export class AcpPendingSteers {
  readonly unsettled = new Set<string>()
  private readonly queue: Steer[] = []
  private inFlight: AcpTurnSend | null = null
  private stopped = 0
  private ended = false

  constructor(
    private readonly deps: Pick<
      AcpStructuredTurnsDeps,
      'connection' | 'steeringSessionId' | 'settle' | 'agentName'
    >,
    private readonly turns: {
      /** A prompt runs, or a model command owns the prompt slot. */
      busy: () => boolean
      joinableTurn: () => AgentJournalItemIdentity | null
      start: (send: AcpTurnSend) => void
      cancel: () => void
      onSettled: () => void
    }
  ) {}

  get held(): boolean {
    return this.queue.length > 0 || this.inFlight !== null
  }

  submit(send: AcpTurnSend, steer: AcpSteerMode): void {
    // Without the extension a mid-turn send keeps the cancel steer the host chose it for.
    const mode = this.deps.steeringSessionId === undefined ? 'cancel' : steer
    this.queue.push({ send, mode })
    if (mode === 'cancel' && this.turns.busy()) {
      this.turns.cancel()
    } else {
      this.advance()
    }
  }

  advance(): void {
    const next = this.queue[0]
    if (!next || this.inFlight || this.ended) {
      return
    }
    if (!this.turns.busy()) {
      this.queue.shift()
      this.turns.start(next.send)
    } else if (next.mode === 'cancel') {
      this.turns.cancel()
    } else if (next.mode !== 'wait') {
      const turn = this.turns.joinableTurn()
      const sessionId = this.deps.steeringSessionId
      if (turn && sessionId !== undefined) {
        this.queue.shift()
        this.inFlight = next.send
        void this.inject(next.send, next.mode, sessionId, turn)
      }
    }
  }

  accept(clientMessageId: string, turn?: AgentJournalItemIdentity): void {
    if (this.unsettled.delete(clientMessageId)) {
      this.deps.settle({
        clientMessageId,
        providerIdentity: { provider: 'orca', clientMessageId },
        ...(turn ? { answeredInTurn: { turn, via: 'steer' } } : {})
      })
    }
  }

  unknown(clientMessageId: string, reason: string): void {
    if (this.unsettled.delete(clientMessageId)) {
      this.deps.settle({ clientMessageId, state: 'unknown', reason })
    }
  }

  reject(clientMessageId: string, fact: SubmissionRejectionFact): void {
    if (this.unsettled.delete(clientMessageId)) {
      this.deps.settle({
        clientMessageId,
        state: 'rejected',
        ...agentSessionFailureWords(fact, { surface: 'rejection', agentName: this.deps.agentName })
      })
    }
  }

  stop(): boolean {
    this.stopped += 1
    return this.withdraw(agentSessionFailureFact('cancelled', { neverReachedAgent: true }))
  }

  end(reason: string): void {
    this.ended = true
    this.withdraw(agentSessionFailureFact('providerExited'))
    if (this.inFlight) {
      this.unknown(this.inFlight.clientMessageId, reason)
      this.inFlight = null
    }
  }

  private withdraw(fact: SubmissionRejectionFact): boolean {
    const withdrawn = this.queue.splice(0)
    for (const { send } of withdrawn) {
      this.reject(send.clientMessageId, fact)
    }
    return withdrawn.length > 0
  }

  private async inject(
    send: AcpTurnSend,
    mode: 'mail' | 'steer',
    sessionId: string,
    turn: AgentJournalItemIdentity
  ): Promise<void> {
    const stop = this.stopped
    const { clientMessageId, prompt } = send
    let outcome: 'injected' | 'promptRequired' | 'failed' | 'unknown' = 'unknown'
    try {
      const reply = steeringReply.safeParse(
        await this.deps.connection.requestExtension('_session/steering', { sessionId, prompt })
      )
      outcome = reply.success ? reply.data.outcome : 'failed'
    } catch (error) {
      // Only the agent's own refusal proves the send was not injected; a lost reply may have been.
      outcome = error instanceof AcpAgentError ? 'failed' : 'unknown'
    }
    if (this.inFlight !== send) {
      return
    }
    this.inFlight = null
    if (outcome === 'injected') {
      this.accept(clientMessageId, turn)
    } else if (outcome === 'unknown') {
      // Resending could deliver it twice.
      this.unknown(clientMessageId, 'ACP steering reply was lost')
    } else if (stop !== this.stopped) {
      this.reject(
        clientMessageId,
        agentSessionFailureFact('cancelled', { neverReachedAgent: true })
      )
    } else {
      // Keep the same submission ahead of newer steers. Mail waits for the turn to end, uncancelled;
      // a person's refused Steer falls back to cancelling it, as a Steer without the extension does.
      this.queue.unshift({
        send,
        mode: mode === 'steer' && outcome === 'failed' ? 'cancel' : 'wait'
      })
    }
    this.advance()
    this.turns.onSettled()
  }
}
