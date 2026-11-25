// A paired DM's streamed replies. Each delivery a chat takes gets a card replied to it at once; while
// its turn runs the card is edited in place, at most once per gap, and the reply outbox writes the
// final words into it. A follow-up the turn took in is told which message answers it.
import type { FeishuLocalState } from '../../shared/bots/feishu-local'
import {
  watchImDeliveryTurns,
  type ImDeliveryTurn,
  type ImStreamJournal
} from '../im-stream/im-stream-delivery-turn'
import { ImLiveStream } from '../im-stream/im-stream-live'
import { readImTurnView } from '../im-stream/im-stream-turn-view'
import type { Binding } from './feishu-binding'
import {
  feishuJoinedCard,
  feishuLiveCard,
  feishuStartCard,
  type FeishuProcess
} from './feishu-card'
import { FeishuApiError, FeishuPermissionDenied, FeishuReplyTargetGone } from './feishu-cli'
import { patchFeishuCard, replyFeishu } from './feishu-replies'
import type { FeishuStore } from './feishu-store-ops'

// Feishu edits a message for 14 days.
const EDITABLE_MS = 13 * 24 * 60 * 60_000
// 230031: the message can no longer be edited.
const NOT_EDITABLE = 230031

export class FeishuStream {
  private readonly lives = new Map<string, ImLiveStream>()
  private readonly also = new Map<string, string[]>()
  private readonly joined = new Set<string>()
  private readonly closing = new Set<string>()
  private watched: { sessionId: string; release: () => void } | null = null
  private missing: string[] | null = null

  constructor(
    private readonly deps: {
      inbox: FeishuStore
      binding: Binding
      signal: AbortSignal
      journal: () => ImStreamJournal | undefined
      linkedSession: () => string | null
      changed: () => void
    }
  ) {}

  get state(): NonNullable<FeishuLocalState['streaming']> {
    return this.missing ? { mode: 'fallback', missing: this.missing } : { mode: 'cards' }
  }

  /** The reply to a delivery a chat just took: a card to stream into, else the text notice. */
  async open(mid: string): Promise<void> {
    const { inbox, binding: b, signal } = this.deps
    const reserved = await inbox.card(b.account, mid)
    if (
      reserved?.card === null &&
      reserved.progress === 0 &&
      (await inbox.takeCard(b.account, mid))
    ) {
      if (!(await this.cardOf(mid)) && b.chat && !signal.aborted) {
        await replyFeishu(
          b.app,
          b.account,
          mid,
          b.chat,
          { type: 'text', content: { text: 'Received in Orca. I’m working on this.' } },
          'progress',
          signal
        ).catch(() => {})
      }
    }
    this.follow()
  }

  /** The card replied to a delivery, or null once it has none. One reserved before a crash replies
   *  again under the same uuid, which Feishu answers within the hour with the card it sent. */
  async cardOf(mid: string): Promise<string | null> {
    const { inbox, binding: b, signal } = this.deps
    const reserved = await inbox.card(b.account, mid)
    if (reserved?.card !== null || reserved.progress !== 2) {
      return reserved?.card || null
    }
    if (!b.chat) {
      return null
    }
    try {
      const card = await replyFeishu(
        b.app,
        b.account,
        mid,
        b.chat,
        { type: 'interactive', content: feishuStartCard() },
        'card',
        signal
      )
      // Only an edit says whether edits are allowed; sending a card never needed that permission.
      await inbox.setCard(b.account, mid, card)
      return card
    } catch (error) {
      if (signal.aborted) {
        throw error
      }
      this.denied(error)
      await inbox.abandonCard(b.account, mid)
      return null
    }
  }

  /** Edits a card to this card JSON, keeping the connector status's word on whether edits are
   *  allowed. */
  async patch(card: string, content: string): Promise<void> {
    try {
      await patchFeishuCard(this.deps.binding.app, card, content, this.deps.signal)
    } catch (error) {
      this.denied(error)
      throw error
    }
    this.allowed()
  }

  /** Watches the chat the DM is linked to now; a delivery may have moved it to a new one. */
  follow(): void {
    const sessionId = this.deps.signal.aborted ? null : this.deps.linkedSession()
    if (this.watched?.sessionId === sessionId) {
      return
    }
    this.watched?.release()
    this.watched = null
    const journal = this.deps.journal()
    if (sessionId && journal) {
      const release = watchImDeliveryTurns(
        journal,
        sessionId,
        this.deps.binding.account,
        (turn) => {
          void this.show(turn).catch(() => {})
        }
      )
      this.watched = { sessionId, release }
    }
  }

  /** Stops a reply's live edits and waits out the one in flight, so the final edit is the last. */
  async finish(mid: string): Promise<void> {
    this.closing.add(mid)
    const live = this.lives.get(mid)
    this.lives.delete(mid)
    this.also.delete(mid)
    await live?.close()
  }

  /** The thinking and steps of the turn a reply answers, for its final card. */
  async process(sessionId: string, messageId: string): Promise<FeishuProcess | null> {
    try {
      const reads = await this.deps.journal()?.journalReads(sessionId)
      return reads ? await readImTurnView(reads, messageId) : null
    } catch {
      return null
    }
  }

  async stop(): Promise<void> {
    this.watched?.release()
    this.watched = null
    const lives = [...this.lives.values()]
    this.lives.clear()
    await Promise.allSettled(lives.map((live) => live.close()))
  }

  private async show({ deliveries, view }: ImDeliveryTurn): Promise<void> {
    const { inbox, binding: b } = this.deps
    const [head, ...rest] = deliveries
    if (!head) {
      return
    }
    if (rest.length > 0) {
      await inbox.merged(b.account, rest, head)
      await this.tellJoined(head, rest)
    }
    if (view.phase !== 'running') {
      // The outbox writes its final words; nothing of this turn is live any more.
      await this.lives.get(head)?.close()
      this.lives.delete(head)
      return
    }
    let live = this.lives.get(head)
    if (!live) {
      const reserved = await inbox.card(b.account, head)
      if (
        !reserved?.card ||
        reserved.progress >= 3 ||
        this.closing.has(head) ||
        this.lives.has(head)
      ) {
        return
      }
      live = this.live(head, reserved.card)
      this.lives.set(head, live)
    }
    if (rest.length > 0) {
      this.also.set(head, await inbox.mergedExcerpts(b.account, head))
    }
    live.update(view)
  }

  private async tellJoined(head: string, rest: readonly string[]): Promise<void> {
    const { inbox, binding: b } = this.deps
    for (const mid of rest.filter((each) => !this.joined.has(each))) {
      const reserved = await inbox.card(b.account, mid)
      // A follow-up whose card isn't out yet is told at a later read, or by the outbox at the end.
      if (reserved?.card && reserved.progress < 3 && !this.joined.has(mid)) {
        this.joined.add(mid)
        const into = (await inbox.card(b.account, head))?.excerpt ?? null
        await this.patch(reserved.card, JSON.stringify(feishuJoinedCard(into))).catch(() => {})
      }
    }
  }

  private live(head: string, card: string): ImLiveStream {
    return new ImLiveStream({
      write: (content) => this.patch(card, content),
      // Anything else, a rate limit (230020) included, is a blip the next frame retries.
      classify: (error) =>
        error instanceof FeishuPermissionDenied
          ? 'permission'
          : error instanceof FeishuReplyTargetGone ||
              (error instanceof FeishuApiError && error.code === NOT_EDITABLE)
            ? 'expired'
            : null,
      render: (view) => JSON.stringify(feishuLiveCard(view, this.also.get(head) ?? [])),
      deadline: Date.now() + EDITABLE_MS,
      onDegraded: () => {}
    })
  }

  private denied(error: unknown): void {
    if (error instanceof FeishuPermissionDenied && this.missing?.join() !== error.scopes.join()) {
      this.missing = error.scopes
      this.deps.changed()
    }
  }

  private allowed(): void {
    if (this.missing) {
      this.missing = null
      this.deps.changed()
    }
  }
}
