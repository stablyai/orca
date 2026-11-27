import { z } from 'zod'
import { FeishuDeliveryAttempts } from './feishu-delivery-attempts'
import { FeishuCardKit } from './feishu-cardkit'
import type { Binding } from './feishu-binding'
import type { FeishuStore } from './feishu-store-ops'
import { cardData } from './feishu-card-data'
import { feishuControlCard } from './feishu-card-render'
import { feishuResponseCard } from './feishu-response-render'
import { feishuCommand } from './feishu-cli'
import { replyFeishu } from './feishu-replies'

export class FeishuCardDelivery {
  private readonly cardkit: FeishuCardKit
  private readonly writes = new Map<string, Promise<unknown>>()
  readonly attempts: FeishuDeliveryAttempts
  name = 'Orca'
  constructor(
    private readonly store: FeishuStore,
    private readonly b: Binding,
    private readonly signal: AbortSignal,
    private readonly active: () => boolean
  ) {
    this.attempts = new FeishuDeliveryAttempts(store, b.account, signal)
    this.cardkit = new FeishuCardKit(store, b, signal)
  }

  publish(id: string): Promise<string | null> {
    // Serialize each card, without making a click wait behind another card's streaming updates.
    const next = (this.writes.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.attempts.run(`card:${id}`, () => this.write(id)))
    this.writes.set(id, next)
    return next.finally(() => {
      if (this.writes.get(id) === next) {
        this.writes.delete(id)
      }
    })
  }

  private async write(id: string): Promise<string | null> {
    if (!this.active() || this.signal.aborted) {
      return null
    }
    // Read inside the write queue so an older patch cannot undo a click or final answer.
    const card = await this.store.getCard(this.b.account, id)
    if (!card) {
      return null
    }
    const data = cardData.parse(JSON.parse(card.body))
    if (data.inline) {
      const parent = await this.store.questionResponse(this.b.account, id)
      const message = parent && (await this.publish(parent.id))
      if (message) {
        await this.store.postedCard(this.b.account, id, card.revision, null)
      }
      return message
    }
    if (card.revision <= card.sent) {
      return card.message
    }
    if (!(await this.store.sendingCard(this.b.account, id, Date.now()))) {
      return null
    }
    const content =
      data.kind === 'response'
        ? feishuResponseCard(data, this.name)
        : feishuControlCard(data, this.name, card.state === 'open')
    let message = card.message
    if (data.kind === 'response' && (card.cardkit || !message)) {
      message = await this.cardkit.write(card, data, this.name)
    } else if (message) {
      const result = await feishuCommand(
        [
          '--profile',
          this.b.app,
          'api',
          'PATCH',
          `/open-apis/im/v1/messages/${message}`,
          '--as',
          'bot',
          '--data',
          '-'
        ],
        this.signal,
        JSON.stringify({ content: JSON.stringify(content) })
      )
      z.object({ ok: z.literal(true), identity: z.literal('bot') }).parse(result)
    } else {
      message = await replyFeishu(
        this.b.app,
        this.b.account,
        card.original,
        card.chat,
        { type: 'interactive', content },
        `card:${id}`,
        this.signal
      )
    }
    await this.store.postedCard(this.b.account, id, card.revision, message)
    const route = await this.store.messageRoute(this.b.account, card.original)
    if (route) {
      await this.store.putRoute(this.b.account, message, route)
    }
    return message
  }
}
