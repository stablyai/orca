import type { Binding } from './feishu-binding'
import type { FeishuStore } from './feishu-store-ops'
import type { FeishuCardRow } from './feishu-card-store'
import type { FeishuCardData } from './feishu-card-data'
import type { BotMember } from '../../shared/bot-types'

export async function continueFeishuChoice(
  store: FeishuStore,
  b: Binding,
  card: FeishuCardRow,
  data: FeishuCardData,
  option: FeishuCardData['options'][number],
  sender: string,
  members: readonly BotMember[]
) {
  const route = await store.laneRoute(b.account, card.external)
  if (!route) {
    await store.closeCard(b.account, card.id, '会话已结束')
    return
  }
  const continuation = data.inline ? await store.questionContinuation(b.account, card.id) : null
  const mid = data.inline ? continuation?.mid : card.message
  if (!mid) {
    await store.closeCard(b.account, card.id, '此问题已结束')
    return
  }
  await store.putRoute(b.account, mid, { ...route, original: mid })
  await store.accept(
    b,
    {
      type: 'im.message.receive_v1',
      chat_type: route.group ? 'group' : 'p2p',
      message_type: 'text',
      create_time: String(Date.now()),
      event_id: `choice:${card.id}`,
      message_id: mid,
      chat_id: card.chat,
      sender_id: sender,
      content: option.answer ?? option.label
    },
    [],
    members,
    { resume: data.kind === 'resume' }
  )
  await store.closeCard(
    b.account,
    card.id,
    data.kind === 'resume' ? '已请求恢复' : `已选择：${option.label}`
  )
}
