import {
  promptPublicationFor,
  type PromptPublication
} from '../external-conversations/external-conversation-prompt-publication'
import { FeishuAsyncQuestions } from './feishu-async-questions'
import { z } from 'zod'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runtimeConversationHost } from '../external-conversations/external-conversation-runtime-host'
import type {
  ConversationEvent,
  ConversationSnapshot
} from '../external-conversations/external-conversation-events'
import { dmKey, type Binding } from './feishu-binding'
import type { FeishuStore } from './feishu-store-ops'
import { cardData } from './feishu-card-data'
import { feishuControlCard, feishuPromptData } from './feishu-card-render'
import { feishuCommand, consumeFeishuEvent } from './feishu-cli'
import { setTimeout as delay } from 'node:timers/promises'
import { replyFeishu } from './feishu-replies'
import { readFeishuClick } from './feishu-card-events'

export class FeishuInteractions {
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
    this.asyncQuestions = new FeishuAsyncQuestions(runtime, store, b, signal, active, wake)
  }

  async listen(checkProfile: () => Promise<void>): Promise<void> {
    while (!this.signal.aborted) {
      try {
        await checkProfile()
        await consumeFeishuEvent(
          this.b.app,
          'card.action.trigger',
          this.signal,
          () => {},
          (line) => this.click(line)
        )
      } catch {
        if (!this.signal.aborted) {
          this.wake()
        }
      }
      if (!this.signal.aborted) {
        await delay(15000, undefined, { signal: this.signal }).catch(() => {})
      }
    }
  }
  event(event: ConversationEvent | ConversationSnapshot): void {
    this.events = this.events
      .then(() => this.record(event))
      .catch(() => {
        this.wake()
      })
  }
  async click(line: string): Promise<void> {
    const click = readFeishuClick(line)
    if (!click || click.operator_id !== this.b.owner || !this.active()) {
      return
    }
    await this.store.claimCard(this.b.account, click.message_id, click.chat_id, click.option)
    this.wake()
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
    } else if (event.kind === 'turn-started') {
      await this.status(source, externalId, '正在处理')
    } else if (event.kind === 'activity' && event.text) {
      await this.status(source, externalId, event.text)
    } else if (event.kind === 'workers') {
      await this.status(
        source,
        externalId,
        event.running ? '子任务仍在运行' : this.asyncQuestions.workStatus(externalId)
      )
    }
    this.wake()
  }
  async status(source: string, external: string, text: string): Promise<void> {
    if (source !== 'feishu-local') {
      return
    }
    const route = await this.store.laneRoute(this.b.account, external)
    if (route) {
      await this.store.putCard(
        this.b.account,
        `status:${external}`,
        external,
        route.root,
        route.chat,
        { kind: 'status', text, options: [] }
      )
    }
  }
  async drain(botName: string): Promise<void> {
    await this.events
    await this.asyncQuestions.flush()
    const b = this.b
    for (const card of await this.store.pendingCards(b.account)) {
      if (!this.active()) {
        return
      }
      const data = cardData.parse(JSON.parse(card.body))
      if (card.state === 'claimed' && card.selected !== null) {
        const option = data.options.find((o) => o.id === card.selected)
        if (!option) {
          await this.store.closeCard(b.account, card.id, '选项已失效')
          continue
        }
        if ((data.kind === 'choices' || data.kind === 'async-question') && card.message) {
          if (
            data.kind === 'async-question' &&
            !this.asyncQuestions.isCurrent(data, card.external)
          ) {
            await this.store.closeCard(b.account, card.id, '此问题已结束')
            continue
          }
          const route = await this.store.laneRoute(b.account, card.external)
          if (!route) {
            await this.store.closeCard(b.account, card.id, '会话已结束')
            continue
          }
          await this.store.putRoute(b.account, card.message, { ...route, original: card.message })
          await this.store.accept(b, {
            type: 'im.message.receive_v1',
            chat_type: route.group ? 'group' : 'p2p',
            message_type: 'text',
            create_time: String(Date.now()),
            event_id: `choice:${card.id}`,
            message_id: card.message,
            chat_id: card.chat,
            sender_id: b.owner!,
            content: option.answer ?? option.label
          })
          await this.store.closeCard(b.account, card.id, `已选择：${option.label}`)
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
        continue
      }
      if (
        card.revision <= card.sent ||
        !(await this.store.sendingCard(b.account, card.id, Date.now()))
      ) {
        continue
      }
      const content = feishuControlCard(data, botName, card.state === 'open')
      let message = card.message
      if (message) {
        const result = await feishuCommand(
          [
            '--profile',
            b.app,
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
          b.app,
          b.account,
          card.original,
          card.chat,
          { type: 'interactive', content },
          `card:${card.id}`,
          this.signal
        )
      }
      await this.store.postedCard(b.account, card.id, card.revision, message)
      const route = await this.store.laneRoute(b.account, card.external)
      if (route) {
        await this.store.putRoute(b.account, message, route)
      }
    }
  }
}
