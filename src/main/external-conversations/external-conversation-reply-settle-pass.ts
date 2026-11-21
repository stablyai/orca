import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalConnectorDelivery } from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { AgentSessionResumeWork } from '../../shared/agent-session/lifecycle/resume/agent-session-resume-marker'
import type { JournalSqlReads } from '../native-chat/agent-session-journal/journal-sql-reads'
import type { ReplyPolicy } from './connector-reply-policy'
import {
  offerNames,
  restartBinding,
  turnEndedAt,
  type RestartBinding
} from './external-conversation-restart-binding'
import { readEndedChatTurnOpener } from './external-conversation-turn-opener'

// One reply-recovery settle of one chat: its journal window, its standing restart offers, and the
// openers and continuations resolved from them once each (design: slack-reply-lost-restart).

type Reads = { journalReads(sessionId: string): Promise<Pick<JournalSqlReads, 'canonicalItemIds'>> }

/** The restart offers a continuation may still answer (the recovery capsule): pending, in an
 *  action, or failed and open to a retry. */
export type ReplyRecoveryOffers = {
  read(now: number): Promise<readonly { sessionId: string; work: AgentSessionResumeWork }[]>
  onChange(listener: () => void): () => void
}

/** This chat's standing restart offers; null when they can't be read (then anything that may be
 *  resumed waits, and the chat is settled again shortly). */
export async function standingOffers(
  offers: ReplyRecoveryOffers | null,
  sessionId: string,
  now: number
): Promise<AgentSessionResumeWork[] | null> {
  if (!offers) {
    return []
  }
  try {
    return (await offers.read(now))
      .filter((offer) => offer.sessionId === sessionId)
      .map((offer) => offer.work)
  } catch (error) {
    console.warn('[connector] could not read restart offers for reply recovery', error)
    return null
  }
}

/** Whether a stamp names this row: its own delivery, or one it carried. */
export const coversRow = (stamp: AgentJournalConnectorDelivery, row: JournalConnectorReplyRow) =>
  stamp.account === row.account &&
  (stamp.deliveryId === row.deliveryId || stamp.carried?.includes(row.deliveryId) === true)

export class SettlePass {
  private readonly openers = new Map<string, Promise<AgentJournalRenderItem | null | undefined>>()
  private readonly bindings = new Map<string, Promise<RestartBinding | null>>()
  // What a continuation in this window verifiably resumes; read by prepare(), before any hold.
  private resumed = new Set<string>()
  /** The earliest durable deadline of a hold this pass kept, if any. */
  holdUntil: number | null = null

  constructor(
    private readonly chat: Reads,
    readonly sessionId: string,
    readonly snapshot: AgentJournalSnapshot,
    /** Null: the offers couldn't be read, so any may stand. */
    private readonly offers: readonly AgentSessionResumeWork[] | null,
    readonly now: number,
    private readonly policy: ReplyPolicy
  ) {}

  /** Resolves every continuation in the window, before any turn's hold is decided. */
  async prepare(): Promise<void> {
    for (const item of this.snapshot.items) {
      const binding = await this.bindingOf(item)
      if (binding) {
        this.resumed.add(binding.resumed.itemId)
      }
    }
  }

  /** A row's message by the stamp it carries: a queued card's handed-off message carries it too. */
  messageOf(row: JournalConnectorReplyRow): AgentJournalRenderItem | undefined {
    return this.snapshot.items.find(
      (item) =>
        item.body.kind === 'message' &&
        item.body.connectorDelivery?.account === row.account &&
        (item.body.connectorDelivery.deliveryId === row.deliveryId ||
          item.body.connectorDelivery.carried?.includes(row.deliveryId) === true)
    )
  }

  /** When a row's request was admitted: its own column, else its message as the journal saw it. */
  admittedAt(row: JournalConnectorReplyRow): number | undefined {
    return row.admittedAt ?? this.messageOf(row)?.observedAt
  }

  openerOf(turnItemId: string): Promise<AgentJournalRenderItem | null | undefined> {
    let opener = this.openers.get(turnItemId)
    if (!opener) {
      const turn = this.snapshot.items.find((item) => item.itemId === turnItemId)
      const items = turn
        ? this.snapshot.items.filter((item) => item.sequence <= turn.sequence)
        : this.snapshot.items
      opener = readEndedChatTurnOpener(
        () => this.chat.journalReads(this.sessionId),
        items,
        turnItemId
      )
      this.openers.set(turnItemId, opener)
    }
    return opener
  }

  /** What a continuation message resumes, verified; null for any other message. */
  bindingOf(message: AgentJournalRenderItem): Promise<RestartBinding | null> {
    if (message.body.kind !== 'message' || !message.body.restartOf) {
      return Promise.resolve(null)
    }
    let binding = this.bindings.get(message.itemId)
    if (!binding) {
      binding = restartBinding(this.snapshot, message, {
        openerOf: (id) => this.openerOf(id),
        chainMax: this.policy.chainMax
      })
      this.bindings.set(message.itemId, binding)
    }
    return binding
  }

  /** An interrupted turn whose requests still wait: a continuation resumes it, or a standing offer
   *  may yet, within the hold's cap from the interruption. */
  turnHeld(
    turn: AgentJournalRenderItem,
    opener: AgentJournalRenderItem | null | undefined
  ): boolean {
    const send = opener
      ? this.snapshot.submissions.find(
          (candidate) => agentJournalSubmissionKey(candidate.clientMessageId) === opener.itemId
        )
      : undefined
    return this.held(turnEndedAt(turn), turn.itemId, {
      turnId: readAgentJournalTurn(turn.body)?.turnId,
      ...(send ? { clientMessageId: send.clientMessageId } : {})
    })
  }

  /** The same for a send the provider exited before taking, which never became a turn. */
  sendHeld(
    message: AgentJournalRenderItem,
    submission: AgentJournalSnapshot['submissions'][number]
  ): boolean {
    return this.held(submission.resolvedAt ?? message.observedAt, message.itemId, {
      clientMessageId: submission.clientMessageId
    })
  }

  private held(
    interruptedAt: number,
    itemId: string,
    work: { turnId?: string; clientMessageId?: string }
  ): boolean {
    const until = interruptedAt + this.policy.holdMaxMs
    if (this.now >= until) {
      return false
    }
    const waiting =
      this.resumed.has(itemId) || this.offers === null || offerNames(this.offers, work)
    if (waiting) {
      this.holdUntil = this.holdUntil === null ? until : Math.min(this.holdUntil, until)
    }
    return waiting
  }
}
