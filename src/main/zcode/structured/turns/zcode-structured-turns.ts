import type { AgentJournalDispatchRejection } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { ZcodeAppServerConnection } from '../../../zcode/app-server/zcode-app-server-connection-types'
import { ZcodeAppServerRequestError } from '../../../zcode/app-server/zcode-app-server-errors'
import type { ZcodeStructuredLane } from '../timeline/zcode-structured-lane'
import type { ZcodeTimelineTranslator } from '../timeline/zcode-timeline-translator'

// zcode's `session/send` answers acceptance immediately; turns end through events. Sends made
// while a turn runs are queued BY THE BACKEND (steer events carry them), so Orca only tracks
// which of its own sends still await a provider echo.

/** The provider's receipt or explicit refusal for one send, as the host's follow-up reads it. */
export type ZcodeSendSettlement =
  | { clientMessageId: string; providerIdentity: AgentJournalItemIdentity }
  | { clientMessageId: string; state: 'unknown'; reason: string }
  | ({ clientMessageId: string; state: 'rejected' } & AgentJournalDispatchRejection)

export type ZcodeTurnsDeps = {
  connection: () => ZcodeAppServerConnection
  lane: () => ZcodeStructuredLane | null
  translator: () => ZcodeTimelineTranslator | null
  agentName: string
  now: () => number
  settle: (settlement: ZcodeSendSettlement) => void
}

export class ZcodeStructuredTurns {
  private readonly unsettled = new Set<string>()
  private ended = false

  constructor(private readonly deps: ZcodeTurnsDeps) {}

  get heldSends(): ReadonlySet<string> {
    return this.unsettled
  }

  /** A send is outstanding until a provider echo or a failure names it. */
  dispatch(input: { clientMessageId: string; text: string }): { state: 'admitted' } {
    this.unsettled.add(input.clientMessageId)
    this.deps.translator()?.beginSend(input.clientMessageId, input.text)
    void this.deps
      .connection()
      .request('session/send', { sessionId: this.sessionId(), content: input.text })
      .then(
        (result) => {
          if (this.isAccepted(result)) {
            // Delivery proof comes from the turn echo; an accepted answer stays admitted.
            return
          }
          this.rejectUnknown(input.clientMessageId, 'zcode answered the send without accepting it')
        },
        (error: unknown) => {
          if (error instanceof ZcodeAppServerRequestError && error.code === -32010) {
            // A background notification turn holds the prompt lock; the send never landed.
            this.rejectUnknown(input.clientMessageId, error.message)
            return
          }
          this.rejectUnknown(
            input.clientMessageId,
            error instanceof Error ? error.message : String(error)
          )
        }
      )
    return { state: 'admitted' }
  }

  private sessionId(): string {
    return this.deps.lane()?.translator.providerSessionId ?? ''
  }

  private isAccepted(result: unknown): boolean {
    return (
      typeof result === 'object' &&
      result !== null &&
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
      (result as { accepted?: unknown }).accepted === true
    )
  }

  /**
   * A provider echo settled this send (input.accepted event). The echo's input message id is the
   * rewind anchor session/messages matches; the turn key is only the fallback spelling.
   */
  accept(
    clientMessageId: string,
    providerTurnId: string | null,
    providerMessageId: string | null
  ): void {
    if (this.unsettled.delete(clientMessageId)) {
      const sessionId = this.sessionId()
      const turnToken = providerMessageId ?? providerTurnId
      this.deps.settle({
        clientMessageId,
        ...(sessionId && turnToken
          ? {
              providerIdentity: {
                provider: 'zcode' as const,
                sessionId,
                turnId: turnToken
              }
            }
          : { providerIdentity: { provider: 'orca' as const, clientMessageId } })
      })
    }
  }

  private rejectUnknown(clientMessageId: string, reason: string): void {
    this.deps.translator()?.forgetSend(clientMessageId)
    if (!this.unsettled.delete(clientMessageId)) {
      return
    }
    this.deps.settle({ clientMessageId, state: 'unknown', reason })
  }

  /** Interrupt the running turn; the backend answers with turn.completed/turn.failed events. */
  async stop(): Promise<void> {
    if (this.ended) {
      return
    }
    this.deps.connection().notify('session/stop', { sessionId: this.sessionId() })
  }

  /** Teardown: every send still owed reads as delivery unknown, never as sent. */
  end(reason: string): void {
    this.ended = true
    // Set iteration tolerates deleting the current entry, so no snapshot copy is needed.
    for (const clientMessageId of this.unsettled) {
      this.deps.translator()?.forgetSend(clientMessageId)
      this.unsettled.delete(clientMessageId)
      this.deps.settle({ clientMessageId, state: 'unknown', reason })
    }
  }
}
