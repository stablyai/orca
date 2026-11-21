import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalSqlReads } from '../native-chat/agent-session-journal/journal-sql-reads'
import type { AgentJournalConnectorDelivery } from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'
import { connectorReplyTurnStamps } from '../../shared/agent-session/journal/journal-connector-reply-turn'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { structuredAgentSessionTurnFailure } from '../../shared/agent-session/requests/structured-agent-session-turn-failure'
import { connectorFailure } from './external-conversation-failure'
import type { ConnectorReplyJournal } from '../connector-cloud/connector-reply-outbox'
import type { ConversationReplyFill } from './external-conversation-reply-fill'
import {
  answerProse,
  BINDING_UNKNOWN,
  personMessagesDuring,
  settledTurnVerdict,
  turnEndedAt
} from './external-conversation-restart-binding'
import { REPLY_POLICY, type ReplyPolicy } from './connector-reply-policy'
import { ReplyExpiries, type ExpiringRow } from './external-conversation-reply-expiry'
import {
  coversRow,
  SettlePass,
  standingOffers,
  type ReplyRecoveryOffers
} from './external-conversation-reply-settle-pass'

export type { ReplyRecoveryOffers }
import { fillByEvidence } from './external-conversation-reply-evidence'
import { ReplySettleTimers } from './external-conversation-reply-settle-timers'

// Design item 125 §3: rows a live turn end didn't fill. Boot fills them from the journal, and a
// watch on each such chat settles the rest as its journal moves (withdrawn cards fill in their own
// transaction; it only wakes the sender). A turn a restart cut is finished (interrupted), but its
// requests wait for the continuation that resumes it, whose answer fills them; a row whose answer or
// request is too old is settled quietly instead (design: slack-reply-lost-restart).

// Chats opened at once by the boot scan (O15).
const OPEN_AT_ONCE = 2
// The restart offers (or a pass's reads) failed: their chats are settled again after this.
const RETRY_MS = 30_000

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
  private readonly timers = new ReplySettleTimers(
    (sessionId) => void this.settle(sessionId),
    () => this.now()
  )
  private offersChanged: (() => void) | null = null
  /** How often the offers changed: a pass that saw them move after it read them fills no cut. */
  private offerChanges = 0
  /** Bumped by dispose, so a pass that was running then schedules nothing after it. */
  private generation = 0
  private readonly expiries: ReplyExpiries

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
      /** Null while no host keeps restart offers: nothing then holds for a continuation. */
      offers?: () => ReplyRecoveryOffers | null
      /** Whether the chat's Slack mirror posts the turn these person-typed messages joined into
       *  this conversation, and with it that turn's answer, itself. */
      mirrorsTo?: (
        sessionId: string,
        externalId: string,
        personItemIds: readonly string[]
      ) => boolean
      now?: () => number
      policy?: ReplyPolicy
    }
  ) {
    this.expiries = new ReplyExpiries(
      () => this.now(),
      () => this.policy
    )
  }

  /** Rows settled quietly, as too old or as told by a mirror, in this process. */
  get expired(): number {
    return this.expiries.expired
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private get policy(): ReplyPolicy {
    return this.deps.policy ?? REPLY_POLICY
  }

  /** One pass over every row: filled ones go, unfilled chats are opened two at a time and settled. */
  async boot(): Promise<void> {
    // Subscribed before the first read: an offer that settles while boot reads settles again.
    this.offersChanged ??=
      this.deps.offers?.()?.onChange(() => {
        this.offerChanges += 1
        ;[...this.watches.keys()].forEach((id) => this.timers.later(id))
      }) ?? null
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
    this.generation += 1
    this.offersChanged?.()
    this.offersChanged = null
    this.watches.forEach((release) => release())
    this.watches.clear()
    this.timers.clear()
  }

  /** A request was admitted to this chat: its journal is watched from now on, subscribed before the
   *  first read, so a withdrawal, rejection or turn end while nothing else listens still settles it. */
  admitted(sessionId: string): void {
    const chat = this.deps.chat()
    if (chat) {
      this.watch(chat, sessionId)
      this.timers.later(sessionId)
    }
  }

  /** A chat's turn ended: rows it left unfilled are watched from now on. */
  turnEnded(sessionId: string): void {
    this.timers.later(sessionId)
  }

  private settle(sessionId: string, open = false): Promise<void> {
    const running = this.settling.get(sessionId)
    if (running) {
      this.again.add(sessionId)
      return running
    }
    const generation = this.generation
    const pass = (async () => {
      do {
        this.again.delete(sessionId)
        await this.settleOnce(sessionId, open).catch((error: unknown) => {
          console.warn('[connector] could not settle reply outbox rows', error)
          // A failed read (at a hold's deadline too) is tried again, not left until something moves.
          if (generation === this.generation) {
            this.timers.deadline(sessionId, this.now() + RETRY_MS)
          }
        })
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
      // No journal left to date them: judged by their own admission time alone.
      await this.expiries.fillOrExpire(journal, unfilled, 'not_found', {
        resolvedAt: () => undefined,
        admittedAt: (row) => row.admittedAt
      })
      this.unwatch(sessionId)
      this.deps.filled()
      return
    }
    if (open) {
      // Opening runs death settlement, so a turn the quit cut short reads interrupted.
      await chat.conversation(sessionId)
    }
    // Watched before the reads below, so a change while they run settles again.
    this.watch(chat, sessionId)
    // The offers before the journal: a continuation is journaled before its offer settles, so a
    // continuation still to come shows in at least one of the two (design D2 §3).
    const offerChanges = this.offerChanges
    const offers = await standingOffers(this.deps.offers?.() ?? null, sessionId, this.now())
    // From the rows' own sends (or the queued cards they carried) to the head, without tool output:
    // the whole journal can be hundreds of MB.
    const { snapshot } = await (
      await chat.journalReads(sessionId)
    ).operationWindow({
      operationIds: unfilled.map((row) => row.messageId),
      withoutToolOutput: true
    })
    const pass = new SettlePass(chat, sessionId, snapshot, offers, this.now(), this.policy, {
      offersMoved: () => this.offerChanges !== offerChanges
    })
    await pass.prepare()
    const messageAt = (row: Unfilled): number => pass.messageOf(row)?.sequence ?? 0
    // Only turns that could have answered a row still unfilled.
    const placed = unfilled.map(messageAt).filter((at) => at > 0)
    const since = placed.length > 0 ? Math.min(...placed) : Number.POSITIVE_INFINITY
    const turns = snapshot.items.filter(
      (item) => item.sequence >= since && readAgentJournalTurn(item.body)
    )
    // Requests a turn with no verdict yet (or one waiting on its continuation) claims: owed and
    // watched until it has one (O3).
    const unresolved: AgentJournalConnectorDelivery[] = []
    for (const turn of turns) {
      unresolved.push(...(await this.fillTurn(journal, pass, turn)))
    }
    await fillByEvidence({
      journal,
      pass,
      turns,
      unresolved,
      expiries: this.expiries,
      agentName: this.deps.agentOf(sessionId)
    })
    if ((await journal.read(sessionId)).some((row) => !row.fill)) {
      this.watch(chat, sessionId)
      // A hold's own deadline, or sooner when the offers couldn't be read.
      const retryAt = offers === null || pass.unknown ? pass.now + RETRY_MS : null
      const at = [pass.holdUntil, retryAt].filter((time): time is number => time !== null)
      this.timers.deadline(sessionId, at.length > 0 ? Math.min(...at) : null)
    } else {
      this.unwatch(sessionId)
    }
    this.deps.filled()
  }

  /** Fills the rows a turn with a verdict answered (its own, and those of the work it resumed);
   *  returns those it claims while it has none, or while its continuation may still come. */
  private async fillTurn(
    journal: ConnectorReplyJournal,
    pass: SettlePass,
    turn: AgentJournalRenderItem
  ): Promise<AgentJournalConnectorDelivery[]> {
    const { sessionId, snapshot } = pass
    const verdict = settledTurnVerdict(turn)
    const opener = await pass.openerOf(turn.itemId)
    const binding = opener ? await pass.bindingOf(opener) : null
    const resumed = binding === BINDING_UNKNOWN ? null : binding
    const stamps = [
      ...connectorReplyTurnStamps(snapshot, opener, turn.itemId),
      ...(resumed?.stamps ?? [])
    ]
    if (
      !verdict ||
      // What it resumed couldn't be read: owed until it can.
      binding === BINDING_UNKNOWN ||
      (verdict === 'interruption' && pass.turnHeld(turn, opener))
    ) {
      // Running, unverifiable, or waiting on its continuation: owed and watched (O3).
      return stamps
    }
    if (stamps.length === 0) {
      return []
    }
    const rows = (await journal.read(sessionId)).filter(
      (row) => !row.fill && stamps.some((stamp) => coversRow(stamp, row))
    )
    // A continuation the chat's Slack mirror already tells the thread: its inherited requests close
    // quietly, so the thread gets one answer, the mirror's.
    const persons = resumed && opener ? personMessagesDuring(snapshot, opener, turn) : []
    const mirrored = (row: Unfilled) =>
      persons.length > 0 &&
      (resumed?.stamps ?? []).some(
        (stamp) =>
          coversRow(stamp, row) &&
          this.deps.mirrorsTo?.(sessionId, stamp.conversation.externalId, persons) === true
      )
    const resolvedAt = turnEndedAt(turn)
    const expiring: ExpiringRow[] = rows.flatMap((row) => {
      const expiry = mirrored(row)
        ? { kind: 'continuation_mirrored' as const }
        : this.expiries.expiryOf(resolvedAt, pass.admittedAt(row))
      return expiry ? [{ row, expiry, outcome: verdict }] : []
    })
    await this.expiries.expire(journal, sessionId, expiring)
    // The rest, with the turn's own answer; rows just settled quietly keep that (first fill wins).
    await this.deps.fillTurn({
      sessionId,
      turnItemId: turn.itemId,
      stamps,
      outcome: verdict,
      prose: answerProse(snapshot.items, turn.itemId, resumed),
      bot: this.deps.isBot(sessionId),
      links: [],
      ...(verdict === 'failure'
        ? {
            failure: connectorFailure(
              structuredAgentSessionTurnFailure(snapshot.items, turn.itemId),
              this.deps.agentOf(sessionId)
            )
          }
        : {})
    })
    return []
  }

  private watch(chat: ReplyRecoveryChat, sessionId: string): void {
    if (!this.watches.has(sessionId)) {
      this.watches.set(
        sessionId,
        chat.observeJournalPublications(sessionId, () => this.timers.later(sessionId))
      )
    }
  }

  private unwatch(sessionId: string): void {
    this.watches.get(sessionId)?.()
    this.watches.delete(sessionId)
    this.timers.deadline(sessionId, null)
  }
}
