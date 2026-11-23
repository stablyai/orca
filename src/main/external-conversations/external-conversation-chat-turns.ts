import type { PendingPrompt } from '../../shared/agent-status/contracts/agent-pending-prompt'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentStatusState } from '../../shared/agent-status/contracts/agent-status-types'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { ConnectorPrompt } from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorWorkLink } from '../../shared/connector-work-link-contract'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { chatPaneKey, type ChatNews } from './external-conversation-chat'
import { promptRaisedBy } from './external-conversation-prompt-audience'
import { PromptTurns } from './external-conversation-prompt-turns'
import type { LinkedConversation } from './external-conversation-links'
import { conversationPane } from './external-conversation-types'
import { isConversationReport } from './external-conversation-turn-opener'
import { ToldWorkLinks } from './external-conversation-told-work-links'
import { ConversationWorkers, type ConversationWorkersDeps } from './external-conversation-workers'
import {
  endAdoptedTurn,
  endMirroredTurn,
  endRepliedTurn,
  legacyTurnWords,
  readOnce,
  turnFailure,
  botTurnReply,
  readCoalescedOutboxCoverage,
  type ChatTurnEnd,
  type ChatTurnReplies,
  type SlackMirrorTurn
} from './external-conversation-turn-ends'

import { chatTurnFor, conversationOwnsTurn, leadOf } from './external-conversation-turn-state'
export { conversationOwnsTurn, leadOf }
export { conversationWorking } from './external-conversation-turn-state'

/**
 * Chats' turn events: starts from the lead's state on the status row; prompts and ends from the host's
 * feed. A turn's end follows its workers' state, so it never reads done while they run.
 */
export class ChatTurns {
  private generation = 0
  // A chat turn's id is the start this told; the host's feed names none.
  private readonly startedAt = new Map<string, number>()
  private readonly leadState = new Map<string, AgentStatusState>()
  // Chats whose current turn the conversation was told of.
  private readonly told = new Set<string>()
  private readonly toldLinks: ToldWorkLinks
  private readonly prompts: PromptTurns
  readonly workers: ConversationWorkers

  constructor(
    private readonly deps: ConversationWorkersDeps &
      ChatTurnReplies & {
        readHookRow: (paneKey: string) => AgentStatusIpcPayload | null
        pendingPrompt: (link: ExternalConversationLink) => PendingPrompt | null
        /** Whether a delivery was sent to the chat and its turn hasn't ended. */
        chatTurnDelivered: (sessionId: string) => boolean
        /** The delivery a chat turn that began at `turnAt` answers; taken once. */
        chatTurnDelivery: (sessionId: string, turnAt: number) => string | undefined
        /** Whether a delivery the chat took waits for a turn to name it. */
        chatTurnWaiting: (sessionId: string) => boolean
        /** Whether reports from workers its conversation's turns started opened the chat's running turn. */
        runningTurnReported: (sessionId: string) => boolean
        /** Read once per ended turn of a bot conversation. */
        workLinks: (link: ExternalConversationLink) => Promise<ConnectorWorkLink[]>
        /** The ended Orca-typed turn's owner posts to its Slack thread (taken once), else null. */
        mirrorTurn?: (sessionId: string) => SlackMirrorTurn | null
        /** Whom a chat's conversation acts for, as Orca recorded it (ConnectorActsFor). */
        actsForOf?: (sessionId: string) => string | undefined
        /** Whether the cloud routes or masks a prompt by who raised it (prompts.audience). Without
         *  it a prompt of a turn its conversation didn't ask for goes nowhere, as before. */
        promptsAudience: () => boolean
        /** The message that opened the chat's running turn; null when none runs. Read once per shown
         *  prompt, and per watch for a link that kept an adopted turn. */
        turnOpener: (sessionId: string) => AgentJournalRenderItem | null
        /** Keeps (or, with undefined, clears) the adopted turn's opener on the link. */
        turnStartedAt?: (sessionId: string) => number | null
        keepAdoptedTurn: (
          linked: LinkedConversation,
          opener: ExternalConversationLink['adoptedTurn']
        ) => void
        /** A chat's turn ended, heard or not. */
        turnEnded?: (paneKey: string) => void
      }
  ) {
    this.workers = new ConversationWorkers(deps)
    this.toldLinks = new ToldWorkLinks(deps.workLinks)
    this.prompts = new PromptTurns({
      ...deps,
      turnOf: (paneKey) => this.turnOf(paneKey),
      hears: (link) => this.hears(link),
      remember: (paneKey, at) => {
        this.startedAt.set(paneKey, at)
        const row = deps.readHookRow(paneKey)
        if (row) {
          this.leadState.set(paneKey, leadOf(row).state)
        }
      }
    })
  }

  /** The turn a chat is in: the one told, else (a watch begun mid-turn) its working lead's start. */
  turnOf(paneKey: string): number | null {
    const known = this.startedAt.get(paneKey)
    if (known !== undefined) {
      return known
    }
    const row = this.deps.readHookRow(paneKey)
    const lead = row?.structuredHost ? leadOf(row) : null
    return lead?.state === 'working'
      ? lead.stateStartedAt
      : (this.deps.turnStartedAt?.(this.deps.linkedFor(paneKey)?.link.sessionId ?? '') ?? null)
  }

  /** Whether the conversation hears of the chat's current turn: its start, prompts, end, snapshot. */
  hears(link: ExternalConversationLink): boolean {
    return this.prompts.adoptedTurn(link)
      ? this.deps.promptsAudience()
      : this.told.has(link.paneKey) || this.owns(link)
  }

  shownPrompt(linked: LinkedConversation, tellStart: boolean): ConnectorPrompt | null {
    return this.prompts.shownPrompt(linked, tellStart)
  }

  /** Why `hears` holds, for a snapshot's trace. */
  heardBy(link: ExternalConversationLink): 'told' | 'delivery' | 'report' | 'none' {
    if (this.told.has(link.paneKey)) {
      return 'told'
    }
    if (!this.owns(link)) {
      return 'none'
    }
    return this.deps.chatTurnDelivered(link.sessionId) ? 'delivery' : 'report'
  }

  private owns(link: ExternalConversationLink): boolean {
    return conversationOwnsTurn(link, {
      delivered: this.deps.chatTurnDelivered,
      reported: this.deps.runningTurnReported
    })
  }

  /** A watch's snapshot tells of a turn begun before it, which is that turn from then on. */
  adopt(paneKey: string): number | null {
    const at = this.turnOf(paneKey)
    if (at !== null) {
      this.startedAt.set(paneKey, at)
      this.leadState.set(paneKey, 'working')
      // A turn adopted for its prompt stays adopted: its end tells no words.
      if (!this.prompts.adopted.has(paneKey)) {
        this.told.add(paneKey)
      }
    }
    return at
  }

  private tell(
    paneKey: string,
    linked: { link: ExternalConversationLink; workspace: { worktreeId: string } },
    at: number
  ): boolean {
    if (!this.owns(linked.link)) {
      return false
    }
    if (this.prompts.adopted.has(paneKey)) {
      return true
    }
    this.told.add(paneKey)
    const deliveryId = this.deps.chatTurnDelivery(linked.link.sessionId, at)
    this.deps.emit({
      kind: 'turn-started',
      ...conversationPane(linked.link, linked.workspace.worktreeId),
      at,
      ...(deliveryId ? { deliveryId } : {})
    })
    return true
  }

  /** The chat's running turn, once its conversation was told it started; null for any other. */
  toldTurn(paneKey: string): number | null {
    return this.told.has(paneKey) ? (this.startedAt.get(paneKey) ?? null) : null
  }

  /** A turn starts when the lead starts working, except on resuming from an answered prompt. */
  observe(paneKey: string): void {
    const row = this.deps.readHookRow(paneKey)
    const linked = row?.structuredHost ? this.deps.linkedFor(paneKey) : null
    if (!row || !linked) {
      return
    }
    const lead = leadOf(row)
    const previous = this.leadState.get(paneKey)
    this.leadState.set(paneKey, lead.state)
    const open = this.startedAt.get(paneKey)
    if (
      lead.state !== 'working' ||
      previous === 'blocked' ||
      previous === 'waiting' ||
      open === lead.stateStartedAt ||
      // Still working with no delivery waiting to start another, a new date is the row re-dating its
      // turn (from the send to its handover), not a new turn.
      (open !== undefined &&
        previous === 'working' &&
        !this.deps.chatTurnWaiting(linked.link.sessionId))
    ) {
      return
    }
    this.startedAt.set(paneKey, lead.stateStartedAt)
    this.told.delete(paneKey)
    this.prompts.adopted.delete(paneKey)
    this.tell(paneKey, linked, lead.stateStartedAt)
  }

  /** A chat linked mid-turn (a bot's shared Chat) joins that turn and its open prompt. */
  joined(paneKey: string, sessionId: string): void {
    const row = this.deps.readHookRow(paneKey)
    const linked = row?.structuredHost ? this.deps.linkedFor(paneKey) : null
    const lead = row ? leadOf(row) : null
    if (!linked || !lead || lead.state === 'done') {
      return
    }
    this.leadState.set(paneKey, lead.state)
    this.startedAt.set(paneKey, lead.stateStartedAt)
    this.tell(paneKey, linked, lead.stateStartedAt)
    this.news({ kind: 'prompt', sessionId })
  }

  /** A delivery an already linked chat took joins the turn begun in Orca it runs, which is the
   *  conversation's from then. An ended turn is never told again. */
  delivered(paneKey: string, sessionId: string): void {
    const at = this.startedAt.get(paneKey)
    const linked = this.deps.linkedFor(paneKey)
    if (at !== undefined && linked && !this.told.has(paneKey) && this.tell(paneKey, linked, at)) {
      this.news({ kind: 'prompt', sessionId })
    }
  }

  news(news: ChatNews): void {
    const generation = this.generation
    const paneKey = chatPaneKey(news.sessionId)
    if (news.kind === 'closed') {
      // Closed mid-turn, the turn ends with no completion: its delivery owns no later turn.
      this.deps.chatTurnOrigin(news.sessionId, this.startedAt.get(paneKey) ?? null)
      this.startedAt.delete(paneKey)
      this.told.delete(paneKey)
      return
    }
    if (news.kind !== 'prompt') {
      this.deps.turnEnded?.(paneKey)
    }
    const linked = this.deps.linkedFor(paneKey)
    const mirrored = news.kind === 'turn-ended' ? this.deps.mirrorTurn?.(news.sessionId) : null
    if (!linked) {
      // Unlinked mid-turn, its end still closes the turn, so a relinked chat's next turn names its delivery.
      if (news.kind !== 'prompt') {
        this.deps.chatTurnOrigin(news.sessionId, this.startedAt.get(paneKey) ?? null)
        this.startedAt.delete(paneKey)
      }
      return
    }
    const at = conversationPane(linked.link, linked.workspace.worktreeId)
    const shared = linked.link.bot?.kind === 'bot-chat'
    if (news.kind === 'prompt') {
      const prompt = this.shownPrompt(linked, true)
      if (prompt) {
        this.deps.emit({ kind: 'prompt', ...at, prompt })
      }
      return
    }
    // Read with the end's turn id in one tick so both name one turn; its message is read later.
    const deliveries =
      (news.mergedTurnCount ?? 1) > 1 ? this.deps.chatTurnOutboxDeliveries?.(news.sessionId) : null
    const origin = this.deps.chatTurnOrigin(news.sessionId, this.turnOf(paneKey))
    const ended = {
      kind: 'turn-ended' as const,
      ...at,
      turnId: this.turnOf(paneKey),
      stopReason: news.outcome,
      at: news.at
    }
    this.startedAt.delete(paneKey)
    const heard = this.told.delete(paneKey) || origin === 'delivery'
    const adopted = this.prompts.adopted.delete(paneKey)
    if (linked.link.adoptedTurn) {
      this.deps.keepAdoptedTurn(linked, undefined)
    }
    const end: ChatTurnEnd = {
      ended,
      news,
      agent: linked.link.agent,
      emit: this.deps.emit,
      turnFor: chatTurnFor(origin, this.deps.actsForOf?.(news.sessionId)),
      workersChecked: () => this.workers.check(paneKey, 'turn-ended'),
      current: () => generation === this.generation
    }
    // A synced Orca-typed turn the thread didn't hear posts its reply too.
    if (mirrored && !heard) {
      return endMirroredTurn(end, mirrored, linked.link)
    }
    // Someone in the thread spoke during it: the thread mirrors the chat, so it gets the answer
    // whatever opened the turn.
    if (adopted && !heard) {
      return endAdoptedTurn(end, this.deps.promptsAudience)
    }
    // A turn begun in Orca never reached the conversation, so its end doesn't either.
    if (shared && !heard) {
      return
    }
    void news.readTurn().then(async (turn) => {
      const fill = this.deps.replyFill?.()
      const requested = heard && origin === 'delivery'
      const outboxed =
        fill && requested
          ? await readCoalescedOutboxCoverage(end, linked.link, turn, deliveries)
          : false
      const reply = botTurnReply(end, linked.link, turn, requested, outboxed)
      const links = readOnce(() => this.toldLinks.next(paneKey, linked.link))
      const replied = await endRepliedTurn(end, turn, linked.link, links, fill, reply)
      if (replied === 'told') {
        return
      }
      const words = legacyTurnWords(turn, linked.link, replied, reply)
      // Mail finishing what its conversation asked (its workers' reports, another bot's answer to its
      // request) woke the chat, so the answer goes back there; other mail is answered in Orca.
      const opener = turn.opener ?? turn.latestOpener
      const reported =
        origin === 'local' && !shared && Boolean(opener && isConversationReport(opener.body))
      if (!heard && !reported) {
        // No one in the thread asked: a bot's turn Orca raised tells how it went, never what it said.
        if (linked.link.bot && promptRaisedBy(linked.link, turn.opener ?? null) === 'orca') {
          endAdoptedTurn(end, this.deps.promptsAudience, turn)
        }
        return
      }
      const [workLinks] = await Promise.all([links(), this.workers.check(paneKey, 'turn-ended')])
      if (generation !== this.generation) {
        return
      }
      // Owner words steered in and posted to the thread go before the answer.
      ;(mirrored ? mirrored.release : this.deps.emit)({
        ...ended,
        ...end.turnFor(turn),
        origin: reported ? 'delivery' : origin,
        ...(words ? { lastAssistantMessage: words } : {}),
        ...turnFailure(end, turn),
        ...(workLinks.length > 0 ? { links: workLinks } : {})
      })
    })
  }

  /** Signed out or another account: a turn end still being read reaches no one. */
  reset(): void {
    this.generation += 1
    this.clear()
  }

  /** A watch went; a turn end still being read reaches the next one. */
  clear(): void {
    this.startedAt.clear()
    this.told.clear()
    this.prompts.clear()
    this.toldLinks.clear()
    this.leadState.clear()
    this.workers.clear()
  }
}
