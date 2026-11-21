import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalSqlReads } from '../native-chat/agent-session-journal/journal-sql-reads'
import type { AgentJournalConnectorDelivery } from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'
import { connectorReplyTurnStamps } from '../../shared/agent-session/journal/journal-connector-reply-turn'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { structuredAgentSessionTurnAssistantMessage } from '../../shared/agent-session/requests/structured-agent-session-latest-request'
import { structuredAgentSessionTurnFailure } from '../../shared/agent-session/requests/structured-agent-session-turn-failure'
import { readAgentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import type { ConnectorFailure } from '../../shared/connectors/connector-cloud-contract'
import { connectorFailure } from './external-conversation-failure'
import type { ConnectorReplyJournal } from '../connector-cloud/connector-reply-outbox'
import { DISPATCH_DOUBT_PROVIDER_EXITED } from '../native-chat/agent-session-journal/projection/journal-dispatch-doubt-reasons'
import type { ConversationReplyFill } from './external-conversation-reply-fill'
import { readEndedChatTurnOpener } from './external-conversation-turn-opener'

// Design item 125 §3: rows a live turn end didn't fill. Boot fills them from the journal, and a
// watch on each such chat settles the rest as its journal moves (withdrawn cards fill in their own
// transaction; it only wakes the sender).

// Chats opened at once by the boot scan (O15).
const OPEN_AT_ONCE = 2
// A watched chat's journal moves with every streamed token; it is settled once it pauses.
const SETTLE_AFTER_MS = 2_000

export type ReplyRecoveryChat = {
  conversation(sessionId: string): Promise<unknown>
  journalReads(
    sessionId: string
  ): Promise<Pick<JournalSqlReads, 'canonicalItemIds' | 'operationWindow'>>
  observeJournalPublications(sessionId: string, observer: () => void): () => void
}

type Unfilled = JournalConnectorReplyRow

export class ConnectorReplyRecovery {
  private readonly watches = new Map<string, () => void>()
  private readonly settling = new Map<string, Promise<void>>()
  private readonly again = new Set<string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly deps: {
      journal: () => ConnectorReplyJournal | null
      chat: () => ReplyRecoveryChat | null
      /** Whether the chat still exists. */
      hasSession: (sessionId: string) => boolean
      /** Whether the chat is a bot's conversation, whose quiet marker means nothing to tell. */
      isBot: (sessionId: string) => boolean
      /** The chat's agent, which names it in the failure a source shows. */
      agentOf: (sessionId: string) => string
      fillTurn: ConversationReplyFill
      /** Rows were filled: wake the sender. */
      filled: () => void
    }
  ) {}

  /** One pass over every row: filled ones go, unfilled chats are opened two at a time and settled. */
  async boot(): Promise<void> {
    const rows =
      (await this.deps
        .journal()
        ?.read()
        .catch((): JournalConnectorReplyRow[] => [])) ?? []
    if (rows.some((row) => row.fill)) {
      this.deps.filled()
    }
    const sessions = [...new Set(rows.filter((row) => !row.fill).map((row) => row.sessionId))]
    const next = async (): Promise<void> => {
      for (let sessionId = sessions.shift(); sessionId; sessionId = sessions.shift()) {
        await this.settle(sessionId, true)
      }
    }
    await Promise.all(Array.from({ length: OPEN_AT_ONCE }, next))
  }

  /** Stops every watch: another host, or connectors off. */
  dispose(): void {
    this.watches.forEach((release) => release())
    this.watches.clear()
    this.timers.forEach((timer) => clearTimeout(timer))
    this.timers.clear()
  }

  /** A request was admitted to this chat: its journal is watched from now on, subscribed before the
   *  first read, so a withdrawal, rejection or turn end while nothing else listens still settles it. */
  admitted(sessionId: string): void {
    const chat = this.deps.chat()
    if (chat) {
      this.watch(chat, sessionId)
      this.later(sessionId)
    }
  }

  /** A chat's turn ended: rows it left unfilled are watched from now on. */
  turnEnded(sessionId: string): void {
    this.later(sessionId)
  }

  private settle(sessionId: string, open = false): Promise<void> {
    const running = this.settling.get(sessionId)
    if (running) {
      this.again.add(sessionId)
      return running
    }
    const pass = (async () => {
      do {
        this.again.delete(sessionId)
        await this.settleOnce(sessionId, open).catch((error: unknown) =>
          console.warn('[connector] could not settle reply outbox rows', error)
        )
      } while (this.again.has(sessionId))
    })().finally(() => this.settling.delete(sessionId))
    this.settling.set(sessionId, pass)
    return pass
  }

  private async settleOnce(sessionId: string, open: boolean): Promise<void> {
    const journal = this.deps.journal()
    const chat = this.deps.chat()
    if (!journal || !chat) {
      return
    }
    const unfilled = (await journal.read(sessionId)).filter((row) => !row.fill)
    if (unfilled.length === 0) {
      this.unwatch(sessionId)
      this.deps.filled()
      return
    }
    if (!this.deps.hasSession(sessionId)) {
      await this.fillEach(journal, unfilled, 'not_found')
      this.unwatch(sessionId)
      this.deps.filled()
      return
    }
    if (open) {
      // Opening runs death settlement, so a turn the quit cut short reads interrupted.
      await chat.conversation(sessionId)
    }
    // From the rows' own sends (or the queued cards they carried) to the head, without tool output:
    // the whole journal can be hundreds of MB.
    const { snapshot } = await (
      await chat.journalReads(sessionId)
    ).operationWindow({
      operationIds: unfilled.map((row) => row.messageId),
      withoutToolOutput: true
    })
    // A row's message by the stamp it carries: a queued card's handed-off message carries it too.
    const messageOf = (row: Unfilled) =>
      snapshot.items.find(
        (item) =>
          item.body.kind === 'message' &&
          item.body.connectorDelivery?.account === row.account &&
          (item.body.connectorDelivery.deliveryId === row.deliveryId ||
            item.body.connectorDelivery.carried?.includes(row.deliveryId) === true)
      )
    const messageAt = (row: Unfilled): number => messageOf(row)?.sequence ?? 0
    // Only turns that could have answered a row still unfilled.
    const placed = unfilled.map(messageAt).filter((at) => at > 0)
    const since = placed.length > 0 ? Math.min(...placed) : Number.POSITIVE_INFINITY
    const turns = snapshot.items.filter(
      (item) => item.sequence >= since && readAgentJournalTurn(item.body)
    )
    // Requests a turn with no verdict yet claims: owed and watched until it has one (O3).
    const unresolved: AgentJournalConnectorDelivery[] = []
    for (const turn of turns) {
      unresolved.push(...(await this.fillTurn(chat, sessionId, snapshot, turn)))
    }
    const claimed = (row: Unfilled) =>
      unresolved.some(
        (stamp) =>
          stamp.account === row.account &&
          (stamp.deliveryId === row.deliveryId || stamp.carried?.includes(row.deliveryId) === true)
      )
    const idle = !turns.some((turn) => readAgentJournalTurn(turn.body)?.state === 'running')
    const lastEnded = Math.max(
      0,
      ...turns
        .filter((turn) => readAgentJournalTurnOutcome(readAgentJournalTurn(turn.body)))
        .map((turn) => turn.sequence)
    )
    // Settled before any turn opened, by the journal's own evidence: a typed rejection failed; a
    // provider that exited before taking it (death settlement) interrupted it. That evidence wins
    // over position; otherwise a delivered message no ended turn's evidence claimed was answered with
    // the turns around it (O8). Anything else stays unfilled and watched (O3).
    const evidence = (row: Unfilled) => {
      const message = messageOf(row)
      const submission = snapshot.submissions.find(
        (candidate) => agentJournalSubmissionKey(candidate.clientMessageId) === message?.itemId
      )
      if (submission && !submission.answeredInTurn) {
        if (submission.dispatchState === 'rejected') {
          return 'failed' as const
        }
        if (
          submission.dispatchState === 'unknown' &&
          submission.recovered === true &&
          submission.reason === DISPATCH_DOUBT_PROVIDER_EXITED
        ) {
          return 'interrupted' as const
        }
      }
      const at = messageAt(row)
      return idle && !claimed(row) && at > 0 && at < lastEnded ? ('unattributed' as const) : null
    }
    const left = (await journal.read(sessionId)).filter((row) => !row.fill)
    // A typed rejection says why, as the live end would.
    const rejection = (row: Unfilled): ConnectorFailure | undefined => {
      const key = messageOf(row)?.itemId
      const fact = readAgentSessionFailureFact(
        snapshot.submissions.find(
          (candidate) => agentJournalSubmissionKey(candidate.clientMessageId) === key
        )?.rejection
      )
      return fact && connectorFailure(fact, this.deps.agentOf(sessionId))
    }
    for (const outcome of ['failed', 'interrupted', 'unattributed'] as const) {
      await this.fillEach(
        journal,
        left.filter((row) => evidence(row) === outcome),
        outcome,
        outcome === 'failed' ? rejection : undefined
      )
    }
    if ((await journal.read(sessionId)).some((row) => !row.fill)) {
      this.watch(chat, sessionId)
    } else {
      this.unwatch(sessionId)
    }
    this.deps.filled()
  }

  /** Fills the rows a turn with a verdict answered; returns those one without a verdict claims. */
  private async fillTurn(
    chat: ReplyRecoveryChat,
    sessionId: string,
    snapshot: AgentJournalSnapshot,
    turn: AgentJournalRenderItem
  ): Promise<AgentJournalConnectorDelivery[]> {
    const outcome = readAgentJournalTurnOutcome(readAgentJournalTurn(turn.body))
    const items = snapshot.items.filter((item) => item.sequence <= turn.sequence)
    const opener = await readEndedChatTurnOpener(
      () => chat.journalReads(sessionId),
      items,
      turn.itemId
    )
    const stamps = connectorReplyTurnStamps(snapshot, opener, turn.itemId)
    if (!outcome) {
      // Running or unverifiable: its requests stay unfilled and watched (O3).
      return stamps
    }
    if (stamps.length > 0) {
      await this.deps.fillTurn({
        sessionId,
        turnItemId: turn.itemId,
        stamps,
        ...(opener ? { openerItemId: opener.itemId } : {}),
        outcome,
        prose: structuredAgentSessionTurnAssistantMessage(snapshot.items, turn.itemId),
        bot: this.deps.isBot(sessionId),
        links: [],
        ...(outcome === 'failure'
          ? {
              failure: connectorFailure(
                structuredAgentSessionTurnFailure(snapshot.items, turn.itemId),
                this.deps.agentOf(sessionId)
              )
            }
          : {})
      })
    }
    return []
  }

  private async fillEach(
    journal: ConnectorReplyJournal,
    rows: readonly Unfilled[],
    outcome: 'not_found' | 'unattributed' | 'failed' | 'interrupted',
    failureOf?: (row: Unfilled) => ConnectorFailure | undefined
  ): Promise<void> {
    await journal.fillOutcomes(
      rows.map((row) => {
        const failure = failureOf?.(row)
        return {
          account: row.account,
          deliveryId: row.deliveryId,
          outcome,
          answerDeliveryId: row.deliveryId,
          ...(failure ? { failure } : {})
        }
      })
    )
  }

  private watch(chat: ReplyRecoveryChat, sessionId: string): void {
    if (!this.watches.has(sessionId)) {
      this.watches.set(
        sessionId,
        chat.observeJournalPublications(sessionId, () => this.later(sessionId))
      )
    }
  }

  private later(sessionId: string): void {
    clearTimeout(this.timers.get(sessionId))
    const timer = setTimeout(() => {
      this.timers.delete(sessionId)
      void this.settle(sessionId)
    }, SETTLE_AFTER_MS)
    timer.unref?.()
    this.timers.set(sessionId, timer)
  }

  private unwatch(sessionId: string): void {
    this.watches.get(sessionId)?.()
    this.watches.delete(sessionId)
  }
}
