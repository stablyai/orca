import { continueFeishuChoice } from './feishu-choice-continuation'
import { feishuAsker } from '../../shared/bots/feishu-members'
import {
  promptPublicationFor,
  type PromptPublication
} from '../external-conversations/external-conversation-prompt-publication'
import { FeishuNativeFeed } from './feishu-native-feed'
import { FeishuAsyncQuestions } from './feishu-async-questions'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runtimeConversationHost } from '../external-conversations/external-conversation-runtime-host'
import type {
  ConversationEvent,
  ConversationSnapshot
} from '../external-conversations/external-conversation-events'
import { dmKey, type Binding } from './feishu-binding'
import type { FeishuStore } from './feishu-store-ops'
import { cardData } from './feishu-card-data'
import { feishuPromptData } from './feishu-card-render'
import { FeishuCardDelivery } from './feishu-card-delivery'
import { handleFeishuClick, listenFeishuCardActions } from './feishu-card-events'
import { offerFeishuResume } from './feishu-resume'

export class FeishuInteractions {
  private readonly native: FeishuNativeFeed
  readonly cards: FeishuCardDelivery
  private events: Promise<void> = Promise.resolve()
  private readonly asyncQuestions: FeishuAsyncQuestions
  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly store: FeishuStore,
    private readonly b: Binding,
    private readonly signal: AbortSignal,
    private readonly active: () => boolean,
    private readonly wake: () => void
  ) {
    this.native = new FeishuNativeFeed(runtime, store, b, signal, active, wake)
    this.cards = new FeishuCardDelivery(store, b, signal, active)
    this.asyncQuestions = new FeishuAsyncQuestions(runtime, store, b, signal, active, wake)
  }

  private members() {
    return this.runtime.bots.list().find((bot) => bot.id === this.b.bot)?.members ?? []
  }
  listen(checkProfile: () => Promise<void>): Promise<void> {
    return listenFeishuCardActions(this.b.app, this.signal, checkProfile, this.wake, (line) =>
      this.click(line)
    )
  }
  event(event: ConversationEvent | ConversationSnapshot): void {
    this.events = this.events
      .then(() => this.record(event))
      .catch(() => {
        this.wake()
      })
  }
  click(line: string): Promise<void> {
    return handleFeishuClick(
      this.store,
      this.b,
      this.members(),
      this.cards,
      this.active,
      this.wake,
      line
    )
  }
  private async record(
    event: ConversationEvent | ConversationSnapshot,
    publication?: PromptPublication
  ): Promise<void> {
    if (!this.active()) {
      return
    }
    if (event.kind === 'snapshot') {
      for (const entry of event.conversations) {
        if (entry.conversation.source !== 'feishu-local') {
          continue
        }
        if (entry.workersRunning !== undefined) {
          await this.record({ ...entry, kind: 'workers', running: entry.workersRunning })
        }
        if (entry.working) {
          this.native.track(entry.conversation.externalId)
        }
        await this.record(
          {
            ...entry,
            kind: 'prompt',
            prompt: entry.prompt ?? { kind: 'unsupported', promptId: 'none' }
          },
          promptPublicationFor(entry)
        )
        await this.status(
          entry.conversation.source,
          entry.conversation.externalId,
          entry.prompt ? '等待你的回答' : entry.working ? '正在处理' : '已完成'
        )
        if (!entry.working && !entry.prompt) {
          await offerFeishuResume(
            this.runtime,
            this.store,
            this.b,
            entry.conversation.externalId,
            entry.turnId
          )
        }
      }
      return
    }
    const { source, externalId } = event.conversation
    if (source !== 'feishu-local') {
      return
    }
    const route = await this.store.laneRoute(this.b.account, externalId)
    if (!route) {
      return
    }
    this.asyncQuestions.track(externalId)
    if (
      event.kind === 'turn-started' ||
      event.kind === 'activity' ||
      (event.kind === 'prompt' && event.prompt.kind !== 'unsupported')
    ) {
      this.native.track(externalId)
    }
    if (event.kind === 'prompt') {
      const prompt = event.prompt
      const supported =
        prompt.kind !== 'unsupported' &&
        prompt.options.length > 0 &&
        prompt.options.length <= 25 &&
        !event.answered
      await this.store.closePrompts(
        this.b.account,
        externalId,
        supported ? prompt.promptId : null,
        event.answered ? '已在 Orca 中回答' : '此问题已结束'
      )
      if (supported) {
        const settled = (publication ?? promptPublicationFor(event))?.start(prompt)
        await this.store
          .putCard(
            this.b.account,
            `prompt:${externalId}:${prompt.promptId}`,
            externalId,
            route.root,
            route.chat,
            feishuPromptData(prompt)
          )
          .then(
            () => settled?.(200),
            (error) => {
              settled?.('network')
              throw error
            }
          )
      }
      await this.status(
        source,
        externalId,
        event.answered
          ? '正在处理'
          : supported
            ? '等待你的选择'
            : prompt.promptId === 'none'
              ? '已就绪'
              : '请在 Orca 中回答此请求'
      )
    } else if (event.kind === 'turn-ended' || event.kind === 'unlinked') {
      await this.store.closePrompts(this.b.account, externalId, null, '此问题已结束')
      await this.status(
        source,
        externalId,
        event.kind === 'unlinked'
          ? '会话已结束'
          : event.resumes
            ? '等待恢复'
            : event.failure
              ? '本次处理失败，请查看回复'
              : '已完成'
      )
      if (event.kind === 'turn-ended' && !event.resumes) {
        await offerFeishuResume(this.runtime, this.store, this.b, externalId, event.turnId)
      }
    } else if (event.kind === 'turn-started') {
      await this.store.closePrompts(this.b.account, externalId, null, '此轮已继续', 'resume')
      await this.store.updateResponse(
        this.b.account,
        externalId,
        event.deliveryId ?? null,
        route.chat,
        { kind: 'start', turn: event.at }
      )
    } else if (event.kind === 'activity' && event.text) {
      await this.store.updateResponse(this.b.account, externalId, null, route.chat, {
        kind: 'trace',
        text: event.text,
        turn: event.turnId
      })
    } else if (event.kind === 'workers') {
      await this.store.updateResponse(this.b.account, externalId, null, route.chat, {
        kind: 'workers',
        running: event.running
      })
    }
    this.wake()
  }
  async status(source: string, external: string, text: string): Promise<void> {
    if (source !== 'feishu-local') {
      return
    }
    const route = await this.store.laneRoute(this.b.account, external)
    if (route) {
      await this.store.updateResponse(this.b.account, external, null, route.chat, {
        kind: 'status',
        text
      })
    }
  }
  async drain(botName: string): Promise<void> {
    this.cards.name = botName
    await this.events
    await this.asyncQuestions.flush()
    await this.native.flush()
    const b = this.b
    let after: string | null = null
    while (this.active()) {
      const rows = await this.store.pendingCards(b.account, after)
      for (const card of rows) {
        after = card.id
        if (!this.active()) {
          return
        }
        await this.cards.attempts.run(`interaction:${card.id}`, async () => {
          const data = cardData.parse(JSON.parse(card.body))
          if (card.state === 'claimed' && card.selected !== null) {
            const sender = data.ownerOnly
              ? b.owner
              : await this.store.laneSender(b.account, card.external)
            if (!feishuAsker(b, this.members(), sender)) {
              await this.store.closeCard(b.account, card.id, '提问权限已撤销')
              return
            }
            if (!(await this.cards.publish(card.id))) {
              return
            }
            const option = data.options.find((o) => o.id === card.selected)
            if (!option) {
              await this.store.closeCard(b.account, card.id, '选项已失效')
              return
            }
            if (
              data.kind === 'choices' ||
              data.kind === 'async-question' ||
              data.kind === 'resume'
            ) {
              if (
                data.kind === 'async-question' &&
                !this.asyncQuestions.isCurrent(data, card.external)
              ) {
                await this.store.closeCard(b.account, card.id, '此问题已结束')
                return
              }
              await continueFeishuChoice(this.store, b, card, data, option, sender!, this.members())
            } else if (data.kind === 'prompt' && data.promptId) {
              const seam = this.runtime.getExternalConversationSeam()
              if (!seam) {
                throw new Error('Conversation host unavailable')
              }
              const result = await seam.answer(
                runtimeConversationHost(this.runtime),
                { ...dmKey(b), externalId: card.external },
                data.promptId,
                option.id
              )
              await this.store.closeCard(
                b.account,
                card.id,
                result.outcome === 'accepted'
                  ? `已选择：${option.label}`
                  : '此问题已失效，请在 Orca 中检查'
              )
            }
            this.wake()
            return
          }
          await this.cards.publish(card.id)
        })
      }
      if (rows.length < 32) {
        break
      }
    }
  }
}
