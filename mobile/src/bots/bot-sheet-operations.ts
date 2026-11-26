import * as z from 'zod'
import {
  BotActivityViewSchema,
  type BotActivityView,
  type BotActivityViewOrigin,
  type BotActivityViewRow
} from '../../../src/shared/bots/bot-activity-schema'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import { phoneBotReply, type PhoneBot } from './host-bots-operations'
import { botMemberSource, type BotMember } from '../../../src/shared/bot-types'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

export type SheetBot = PhoneBot

export const botUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.update',
    method: 'bots.update',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('sheet-bot-updated', phoneBotReply)
  })
)

export const botAvatarUpload = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.avatar.upload',
    method: 'bots.avatar.upload',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-avatar-uploaded', phoneBotReply)
  })
)

/** Its folder, soul and memory stay: the phone never sends deleteFolder, as the desktop never does. */
export const botDelete = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.delete',
    method: 'bots.delete',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-deleted', z.looseObject({ deleted: z.boolean() }))
  })
)

/** A New bot from the phone; the host speaks first in its Home Chat, as for one made on the desktop. */
export const botCreate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.create',
    method: 'bots.create',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-created', phoneBotReply)
  })
)

export const botSessionStart = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.session-start',
    method: 'bots.session.start',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-session-started', z.looseObject({ sessionId: z.string().min(1) }))
  })
)

/** Sends a new bot's setup again; the host answers a repeat of the same send with the first. */
export const botKickoffRetry = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.kickoff-retry',
    method: 'bots.kickoff.retry',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-kickoff-retried', z.looseObject({}))
  })
)

/** A fresh Home Chat for the bot; its old conversation stays in its chats. */
export const botHomeChatReset = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.chat-reset',
    method: 'bots.chat.reset',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-chat-reset', z.looseObject({ sessionId: z.string().min(1) }))
  })
)

/** Sends a wait's run that couldn't start into its chat, once ever; the host refuses a second. */
export const botRunSendAgain = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.send-run-again',
    method: 'bots.sendRunAgain',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-run-sent-again', z.looseObject({ sessionId: z.string().min(1) }))
  })
)

export type SheetActivity = BotActivityView
export type SheetActivityRow = BotActivityViewRow
export type SheetActivityOrigin = BotActivityViewOrigin

export const botActivityRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.activity-or-skip',
    method: 'bots.activity',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-activity', z.looseObject({ activity: BotActivityViewSchema }))
  })
)

/** The update that stops one person asking the bot. */
export function memberRemoval(member: BotMember) {
  return {
    removeMember: {
      id: member.id,
      source: botMemberSource(member),
      ...(member.workspaceId ? { workspaceId: member.workspaceId } : {})
    }
  }
}

/** Takes each person off with its own removeMember, which every host applies to its current roster (a stale roster would restore someone revoked elsewhere), then saves `updates`; stops at the first failed save. */
export async function saveRemovingMembers<U extends object>(
  save: (updates: U | ReturnType<typeof memberRemoval>) => Promise<boolean>,
  members: readonly BotMember[],
  updates: U
): Promise<boolean> {
  for (const member of members) {
    if (!(await save(memberRemoval(member)))) {
      return false
    }
  }
  return save(updates)
}

/** Keep only me: one removal each, on the host, so a concurrent edit is kept and an older host
 *  takes it. Resolves to the names of whoever couldn't be removed. */
export async function removeEveryoneWhoCanAsk(
  client: RpcClient,
  bot: { id: string; members: readonly BotMember[] },
  onBot: (bot: PhoneBot) => void
): Promise<string[]> {
  const failed: string[] = []
  for (const member of bot.members) {
    try {
      onBot(
        botUpdate.interpret(
          await botUpdate.request(
            client,
            { botId: bot.id, updates: memberRemoval(member) },
            { failWhenDisconnected: true }
          )
        ).bot
      )
    } catch {
      failed.push(member.name || member.id)
    }
  }
  return failed
}
