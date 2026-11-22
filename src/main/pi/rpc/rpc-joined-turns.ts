import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionDispatchOutcome } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'

/** Pi steers a send it takes while a turn runs into that turn: each such send's turn, until its
 *  acceptance settles. */
export class PiRpcJoinedTurns {
  private readonly joined = new Map<string, AgentJournalItemIdentity>()

  constructor(
    private readonly turns: { readonly working: boolean },
    private readonly lane: { readonly openTurnIdentity: AgentJournalItemIdentity | null }
  ) {}

  /** Before Pi opens a turn for the send: a turn already running is the one it joins. */
  accepting(clientMessageId: string): void {
    const running = this.turns.working ? this.lane.openTurnIdentity : null
    if (running) {
      this.joined.set(clientMessageId, running)
    }
  }

  /** The send's acceptance, naming the running turn it joined. */
  accepted(clientMessageId: string): Extract<AgentSessionDispatchOutcome, { state: 'accepted' }> {
    const turn = this.joined.get(clientMessageId)
    this.joined.delete(clientMessageId)
    return {
      state: 'accepted',
      providerIdentity: { provider: 'orca', clientMessageId },
      ...(turn ? { answeredInTurn: { turn, via: 'steer' } } : {})
    }
  }
}
