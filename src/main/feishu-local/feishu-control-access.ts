import type { Binding } from './feishu-binding'
import type { BotMember } from '../../shared/bot-types'
import { feishuAsker } from '../../shared/bots/feishu-members'
import type { FeishuAdmissions } from './feishu-admissions'
import type { FeishuCardStore } from './feishu-card-store'
import { cardData } from './feishu-card-data'

export function claimFeishuControl(
  cards: FeishuCardStore,
  admissions: FeishuAdmissions,
  b: Binding,
  members: readonly BotMember[],
  actor: string,
  message: string,
  chat: string,
  option: string,
  question?: string
) {
  if (!feishuAsker(b, members, actor)) {
    return null
  }
  const parent = cards.byMessage(b.account, message, chat)
  if (!parent) {
    return null
  }
  const control = question ? cards.get(b.account, question) : parent
  if (!control || control.external !== parent.external || control.chat !== chat) {
    return null
  }
  const data = cardData.parse(JSON.parse(control.body))
  const allowed = data.ownerOnly ? b.owner : admissions.laneSender(b.account, parent.external)
  if (actor !== allowed) {
    return null
  }
  return cards.claim(b.account, message, chat, option, question)
}
