import { z } from 'zod'
import type { Binding } from './feishu-binding'
import type { FeishuStore } from './feishu-store-ops'
import type { FeishuCardRow } from './feishu-card-store'
import type { FeishuCardData } from './feishu-card-data'
import { feishuCommand } from './feishu-cli'
import { replyFeishu } from './feishu-replies'
import { feishuResponseCard, feishuResponseText } from './feishu-response-render'
import {
  streamCardContent,
  updateCardKitCard,
  setCardStreamingMode,
  type CardKitRequest
} from './upstream/cardkit-transport'

export class FeishuCardKit {
  private readonly sent = new Map<string, { layout: string; text: string }>()
  constructor(
    private readonly store: FeishuStore,
    private readonly b: Binding,
    private readonly signal: AbortSignal
  ) {}
  private request: CardKitRequest = async (method, path, data) => {
    const result = await feishuCommand(
      ['--profile', this.b.app, 'api', method, path, '--as', 'bot', '--data', '-'],
      this.signal,
      JSON.stringify(data)
    )
    z.object({ ok: z.literal(true), identity: z.literal('bot') }).parse(result)
  }
  async write(card: FeishuCardRow, data: FeishuCardData, name: string): Promise<string> {
    const content = feishuResponseCard(data, name, true)
    let entity = card.cardkit
    if (!entity) {
      const result = await feishuCommand(
        [
          '--profile',
          this.b.app,
          'api',
          'POST',
          '/open-apis/cardkit/v1/cards',
          '--as',
          'bot',
          '--data',
          '-'
        ],
        this.signal,
        JSON.stringify({ type: 'card_json', data: JSON.stringify(content) })
      )
      entity = z
        .object({
          ok: z.literal(true),
          identity: z.literal('bot'),
          data: z.object({ card_id: z.string().regex(/^\d+$/) })
        })
        .parse(result).data.card_id
      await this.store.cardkit(this.b.account, card.id, entity)
    }
    const sequence = () => this.store.cardSequence(this.b.account, card.id)
    const complete = data.response?.final !== undefined || Boolean(data.response?.supersededBy)
    const text = feishuResponseText(data)
    // Layout changes replace the card; ordinary token updates touch only the answer element.
    const layout = JSON.stringify({
      tools: data.response?.native?.tools,
      trace: data.response?.native ? undefined : data.response?.trace,
      complete,
      answerFormat: text.includes('![') || /<img\b/i.test(text) ? 'plain' : 'markdown',
      hasText: Boolean(text),
      phase: data.response?.phase
    })
    const previous = this.sent.get(card.id)
    if (complete) {
      await setCardStreamingMode(this.request, entity, false, await sequence())
      await updateCardKitCard(this.request, entity, content, await sequence())
    } else if (!previous || previous.layout !== layout) {
      await updateCardKitCard(this.request, entity, content, await sequence())
    } else if (text !== previous.text && text && !text.includes('![') && !/<img\b/i.test(text)) {
      await streamCardContent(this.request, entity, text, await sequence())
    } else if (text !== previous.text) {
      await updateCardKitCard(this.request, entity, content, await sequence())
    }
    this.sent.set(card.id, { layout, text })
    if (this.sent.size > 128) {
      this.sent.delete(this.sent.keys().next().value!)
    }
    return (
      card.message ??
      replyFeishu(
        this.b.app,
        this.b.account,
        card.original,
        card.chat,
        { type: 'interactive', content: { type: 'card', data: { card_id: entity } } },
        `card:${card.id}`,
        this.signal
      )
    )
  }
}
