import { CommanderChatRecentResult } from '../../../src/shared/rpc-contract/commander-chat'
import type { z } from 'zod'
import {
  commanderMemoryPage,
  commanderRecurringAnswerSetting
} from '../../../src/shared/commander/memory-contract'
import {
  commanderPhonePage,
  commanderPhonePages,
  commanderPhoneStatus,
  type commanderPhoneSummary
} from '../../../src/shared/rpc-contract/commander-phone-params'
import { defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'

export type PhonePageSummary = z.infer<typeof commanderPhoneSummary>
export type PhonePages = z.infer<typeof commanderPhonePages>
export type PhonePage = z.infer<typeof commanderPhonePage>
export type PhoneRecurringAnswerSetting = z.infer<typeof commanderRecurringAnswerSetting>
export type PhoneStatus = z.infer<typeof commanderPhoneStatus>

export const phoneStatusRead = defineRpcOperation({
  name: 'commander-phone.status',
  method: 'commanderPhone.status',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant('status', commanderPhoneStatus)
})
export const phoneRecurringAnswers = defineRpcOperation({
  name: 'commander-phone.recurring-answers',
  method: 'commanderPhone.recurringAnswers',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant('setting', commanderRecurringAnswerSetting)
})
export const phoneListRead = defineRpcOperation({
  name: 'commander-phone.list',
  method: 'commanderPhone.list',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant('pages', commanderPhonePages)
})
export const phonePageRead = defineRpcOperation({
  name: 'commander-phone.read',
  method: 'commanderPhone.read',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant('page', commanderPhonePage)
})
export const phonePageWrite = defineRpcOperation({
  name: 'commander-phone.save',
  method: 'commanderPhone.save',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant('saved', commanderMemoryPage)
})

export const phoneCommanderRecentRead = defineRpcOperation({
  name: 'commander-chat.recent',
  method: 'commanderChat.recent',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant('recent', CommanderChatRecentResult)
})
