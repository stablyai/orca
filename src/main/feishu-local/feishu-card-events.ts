import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import type { FeishuStore } from './feishu-store-ops'
import type { Binding } from './feishu-binding'
import type { BotMember } from '../../shared/bot-types'
import type { FeishuCardDelivery } from './feishu-card-delivery'
import { consumeFeishuEvent } from './feishu-cli'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'

const click = lazyZodSchema(() =>
  z.object({
    type: z.literal('card.action.trigger'),
    operator_id: z.string().regex(/^ou_[a-zA-Z0-9_-]+$/),
    message_id: z.string().regex(/^om_[a-zA-Z0-9_-]+$/),
    chat_id: z.string().regex(/^oc_[a-zA-Z0-9_-]+$/),
    host: z.literal('im_message'),
    action_tag: z.literal('button'),
    action_value: z.string()
  })
)
const choice = lazyZodSchema(() =>
  z.object({
    orca: z.literal('answer'),
    option: z.string().min(1).max(256),
    question: z.string().min(1).max(1024).optional()
  })
)
export function readFeishuClick(line: string) {
  try {
    const event = click.parse(JSON.parse(line))
    return { ...event, ...choice.parse(JSON.parse(event.action_value)) }
  } catch {
    return null
  }
}

export async function listenFeishuCardActions(
  app: string,
  signal: AbortSignal,
  checkProfile: () => Promise<void>,
  wake: () => void,
  click: (line: string) => Promise<void>
): Promise<void> {
  while (!signal.aborted) {
    try {
      await checkProfile()
      await consumeFeishuEvent(app, 'card.action.trigger', signal, () => {}, click)
    } catch {
      if (!signal.aborted) {
        wake()
      }
    }
    if (!signal.aborted) {
      await delay(15000, undefined, { signal }).catch(() => {})
    }
  }
}

export async function handleFeishuClick(
  store: FeishuStore,
  b: Binding,
  members: readonly BotMember[],
  cards: FeishuCardDelivery,
  active: () => boolean,
  wake: () => void,
  line: string
): Promise<void> {
  const click = readFeishuClick(line)
  if (!click || !active()) {
    return
  }
  const card = await store.claimCardFor(
    b,
    members,
    click.operator_id,
    click.message_id,
    click.chat_id,
    click.option,
    click.question
  )
  try {
    if (card) {
      await cards.publish(card.id)
    }
  } finally {
    wake()
  }
}
